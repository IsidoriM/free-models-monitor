import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { mapLimit } from './http.js';

const CHUNK_BYTES = 1024 * 1024;
const PROGRESS_INTERVAL_MS = 250;
const UNREADABLE_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'EBUSY', 'ELOOP', 'ENAMETOOLONG', 'EMFILE', 'ENFILE']);

/** Streams a file through SHA-256 so huge files never sit in memory. */
async function hashFile(filePath, size) {
  const handle = await open(filePath, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size || CHUNK_BYTES));
    let remaining = size;
    while (remaining > 0) {
      const wanted = Math.min(buffer.length, remaining);
      const { bytesRead } = await handle.read(buffer, 0, wanted);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

/**
 * Read-only duplicate finder.
 *
 * Runs in two phases so a full home directory stays affordable: the walk only
 * buckets files by byte size, then SHA-256 is computed for the (small) subset of
 * files that share a size with at least one other file. Nothing is ever
 * written, moved or deleted - the scanner only reports.
 *
 * Emits `update` with `{ status, result }` on every transition and on throttled
 * progress ticks, so the HTTP layer can push straight to the browser.
 */
export class DuplicateScanner extends EventEmitter {
  #exclude;
  #running = false;
  #cancelled = false;
  #progressAt = 0;
  #result = null;
  #status;

  constructor({ config, logger = console }) {
    super();
    this.config = config;
    this.logger = logger;
    this.#exclude = new Set((config.exclude ?? []).map((name) => name.toLowerCase()));
    this.#status = {
      state: 'idle',
      phase: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      roots: [...(config.roots ?? [])],
      filesSeen: 0,
      candidatesHashed: 0,
      bytesHashed: 0,
      skippedDirs: 0,
      unreadable: 0,
      truncated: false,
      error: null,
    };
  }

  getStatus() {
    return { ...this.#status };
  }

  getResult() {
    return this.#result;
  }

  /** Everything the UI needs in a single payload. */
  snapshot() {
    return { status: this.getStatus(), result: this.#result };
  }

  isRunning() {
    return this.#running;
  }

  cancel() {
    if (this.#running) this.#cancelled = true;
  }

  /** Kicks off a scan without waiting; failures land in `status.error`. */
  start() {
    if (this.#running) throw new Error('a duplicate scan is already running');
    this.scan().catch((error) => {
      this.logger.error?.(`duplicate scan failed: ${error.message}`);
    });
    return this.getStatus();
  }

  async scan() {
    if (this.#running) throw new Error('a duplicate scan is already running');
    this.#running = true;
    this.#cancelled = false;
    this.#result = null;
    this.#status = {
      ...this.#status,
      state: 'scanning',
      phase: 'walking',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      filesSeen: 0,
      candidatesHashed: 0,
      bytesHashed: 0,
      skippedDirs: 0,
      unreadable: 0,
      truncated: false,
      error: null,
    };
    this.#emitUpdate(true);

    const startedAt = Date.now();
    try {
      const files = await this.#walk();
      if (this.#cancelled) return this.#finish(startedAt, 'cancelled');

      this.#status.phase = 'hashing';
      this.#status.filesSeen = files.length;
      this.#emitUpdate(true);

      const bySize = new Map();
      for (const file of files) {
        const bucket = bySize.get(file.size);
        if (bucket) bucket.push(file);
        else bySize.set(file.size, [file]);
      }

      const candidates = [...bySize.values()].filter((bucket) => bucket.length > 1).flat();
      const hashes = await this.#hashAll(candidates);
      if (this.#cancelled) return this.#finish(startedAt, 'cancelled');

      this.#result = this.#buildResult(hashes, startedAt);
      return this.#finish(startedAt, 'done');
    } catch (error) {
      this.#status.error = error.message;
      this.logger.error?.(`duplicate scan failed: ${error.message}`);
      return this.#finish(startedAt, 'error');
    } finally {
      this.#running = false;
    }
  }

  #finish(startedAt, state) {
    this.#status.state = state;
    this.#status.phase = null;
    this.#status.finishedAt = new Date().toISOString();
    this.#status.durationMs = Date.now() - startedAt;
    this.#emitUpdate(true);
    return this.#result;
  }

  /** Depth-first walk that returns every candidate regular file. */
  async #walk() {
    const { roots, maxFiles, maxDepth, minSizeBytes, maxFileBytes, concurrency } = this.config;
    const files = [];
    const stack = [];

    for (const root of roots) {
      stack.push({ dir: root, depth: 0 });
    }

    while (stack.length > 0) {
      if (this.#cancelled || files.length >= maxFiles) break;
      const { dir, depth } = stack.pop();

      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        this.#noteUnreadable(dir, error);
        continue;
      }

      const subdirectories = [];
      await mapLimit(entries, concurrency, async (entry) => {
        if (entry.isSymbolicLink()) return 'skip';
        if (entry.isDirectory()) {
          if (!this.#exclude.has(entry.name.toLowerCase()) && depth + 1 < maxDepth) {
            subdirectories.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
          }
          return 'skip';
        }
        if (!entry.isFile()) return 'skip';

        let info;
        try {
          info = await stat(path.join(dir, entry.name));
        } catch (error) {
          this.#noteUnreadable(entry.name, error);
          return 'skip';
        }
        if (info.size < minSizeBytes) return 'skip';
        if (maxFileBytes > 0 && info.size > maxFileBytes) return 'skip';

        files.push({
          path: path.join(dir, entry.name),
          name: entry.name,
          dir,
          size: info.size,
          modifiedAt: new Date(info.mtimeMs).toISOString(),
        });
        return 'file';
      });

      this.#status.filesSeen = files.length;
      if (files.length >= maxFiles) this.#status.truncated = true;

      // Reversed so the traversal stays alphabetical-ish and deterministic.
      for (let i = subdirectories.length - 1; i >= 0; i -= 1) stack.push(subdirectories[i]);
    }

    this.#status.filesSeen = files.length;
    if (this.#status.filesSeen >= maxFiles) this.#status.truncated = true;
    this.#emitUpdate();
    return files;
  }

  async #hashAll(candidates) {
    const hashed = [];
    let bytes = 0;

    const results = await mapLimit(candidates, this.config.concurrency, async (file) => {
      if (this.#cancelled) return { file, hash: null };
      try {
        const hash = await hashFile(file.path, file.size);
        bytes += file.size;
        this.#status.bytesHashed = bytes;
        return { file, hash };
      } catch (error) {
        this.#noteUnreadable(file.path, error);
        return { file, hash: null };
      } finally {
        this.#status.candidatesHashed += 1;
        if (this.#status.candidatesHashed % 8 === 0) this.#emitUpdate();
      }
    });

    for (const entry of results) {
      if (entry.ok && entry.value.hash) hashed.push(entry.value);
    }
    return hashed;
  }

  #buildResult(hashed, startedAt) {
    const byDigest = new Map();
    for (const entry of hashed) {
      const key = `${entry.file.size}:${entry.hash}`;
      const bucket = byDigest.get(key);
      if (bucket) bucket.push(entry);
      else byDigest.set(key, [entry]);
    }

    const groups = [];
    let duplicateFiles = 0;
    let wastedBytes = 0;

    for (const entries of byDigest.values()) {
      if (entries.length < 2) continue;
      const size = entries[0].file.size;
      const wasted = size * (entries.length - 1);
      duplicateFiles += entries.length;
      wastedBytes += wasted;
      groups.push({
        hash: entries[0].hash,
        shortHash: entries[0].hash.slice(0, 12),
        size,
        count: entries.length,
        wasted,
        paths: entries
          .map((entry) => entry.file)
          .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })),
      });
    }

    groups.sort((a, b) => b.wasted - a.wasted || b.size - a.size || a.paths[0].path.localeCompare(b.paths[0].path));
    const truncated = groups.length > this.config.topGroups;

    return {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      roots: [...this.#status.roots],
      minSizeBytes: this.config.minSizeBytes,
      groupsShown: Math.min(groups.length, this.config.topGroups),
      groupsTruncated: truncated,
      groups: groups.slice(0, this.config.topGroups),
      totals: {
        groups: groups.length,
        duplicateFiles,
        wastedBytes,
        wastedFiles: duplicateFiles - groups.length,
      },
    };
  }

  #noteUnreadable(where, error) {
    this.#status.unreadable += 1;
    if (!UNREADABLE_CODES.has(error.code)) {
      this.logger.warn?.(`duplicate scan skipped ${where}: ${error.code ?? error.message}`);
    }
  }

  #emitUpdate(force = false) {
    const now = Date.now();
    if (!force && now - this.#progressAt < PROGRESS_INTERVAL_MS) return;
    this.#progressAt = now;
    this.emit('update', this.snapshot());
  }
}
