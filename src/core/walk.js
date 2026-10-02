import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { mapLimit } from './http.js';

const UNREADABLE_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'EBUSY', 'ELOOP', 'ENAMETOOLONG', 'EMFILE', 'ENFILE']);

/** Permission and race errors are expected on a live home folder, not worth a warning. */
export function isExpectedUnreadable(error) {
  return UNREADABLE_CODES.has(error.code);
}

/**
 * Depth-first, symlink-free directory walk shared by the read-only scanners.
 *
 * Every regular file in range is collected in memory because both callers post-process
 * the whole set (name, folder and byte heuristics for trojans, extension and folder
 * buckets for typologies). The walk stops at `maxFiles` and at `maxDepth`, and never
 * follows symbolic links, so cycles and huge trees stay bounded. Nothing is written,
 * moved or deleted.
 */
export async function walkFiles({
  roots,
  exclude = [],
  maxFiles = 750_000,
  maxDepth = 12,
  concurrency = 6,
  minSizeBytes = 1,
  maxFileBytes = 0,
  isCancelled = () => false,
  onProgress = null,
  onUnreadable = null,
}) {
  const excluded = new Set(exclude.map((name) => name.toLowerCase()));
  const files = [];
  const stats = { unreadable: 0, skippedDirs: 0, truncated: false, cancelled: false };
  const noteUnreadable = (where, error) => {
    stats.unreadable += 1;
    onUnreadable?.(where, error);
  };
  const stack = [...(roots ?? [])].map((root) => ({ dir: root, depth: 0 }));

  while (stack.length > 0) {
    if (isCancelled()) {
      stats.cancelled = true;
      break;
    }
    if (files.length >= maxFiles) {
      stats.truncated = true;
      break;
    }

    const { dir, depth } = stack.pop();

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      noteUnreadable(dir, error);
      continue;
    }

    const subdirectories = [];
    await mapLimit(entries, concurrency, async (entry) => {
      if (entry.isSymbolicLink()) return 'skip';
      if (entry.isDirectory()) {
        if (excluded.has(entry.name.toLowerCase()) || depth + 1 >= maxDepth) {
          stats.skippedDirs += 1;
          return 'skip';
        }
        subdirectories.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        return 'skip';
      }
      if (!entry.isFile()) return 'skip';

      let info;
      try {
        info = await stat(path.join(dir, entry.name));
      } catch (error) {
        noteUnreadable(entry.name, error);
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

    onProgress?.(files.length);

    // Reversed so the traversal stays alphabetical-ish and deterministic.
    for (let i = subdirectories.length - 1; i >= 0; i -= 1) stack.push(subdirectories[i]);
  }

  if (files.length >= maxFiles) stats.truncated = true;
  return { files, ...stats };
}
