import { EventEmitter } from 'node:events';
import path from 'node:path';

import { isExpectedUnreadable, walkFiles } from './walk.js';

const PROGRESS_INTERVAL_MS = 250;
const PROGRESS_EVERY = 500;

const collator = new Intl.Collator(undefined, { numeric: true });

/**
 * The taxonomy behind the FileTypologies page: the extensions a person would
 * use to describe a folder, in the order they read best. Extensions are
 * lowercase and dotted; anything unlisted lands in the unknown bucket.
 */
const TYPOLOGY_DEFS = [
  {
    id: 'documents',
    label: 'documents',
    hint: 'prose, pdf and ebooks',
    extensions: [
      '.pdf', '.doc', '.docx', '.docm', '.dot', '.dotx', '.odt', '.ott', '.rtf', '.txt', '.md', '.markdown',
      '.epub', '.mobi', '.azw', '.azw3', '.pages', '.wpd', '.tex', '.abw', '.lit', '.prt',
    ],
  },
  {
    id: 'spreadsheets',
    label: 'spreadsheets',
    hint: 'tables, including flat exports',
    extensions: ['.xls', '.xlsx', '.xlsm', '.xlsb', '.xltx', '.xltm', '.ods', '.ots', '.csv', '.tsv', '.numbers', '.wps'],
  },
  {
    id: 'presentations',
    label: 'presentations',
    hint: 'slides and decks',
    extensions: ['.ppt', '.pptx', '.pptm', '.pps', '.ppsx', '.odp', '.otp', '.key'],
  },
  {
    id: 'images',
    label: 'images',
    hint: 'photos, drawings and design sources',
    extensions: [
      '.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.apng', '.gif', '.bmp', '.dib', '.webp', '.svg', '.tif', '.tiff',
      '.ico', '.icns', '.heic', '.heif', '.avif', '.jxl', '.raw', '.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf',
      '.rw2', '.psd', '.psb', '.ai', '.xcf', '.sketch', '.fig', '.afphoto', '.afdesign', '.cdr',
    ],
  },
  {
    id: 'audio',
    label: 'audio',
    hint: 'music, samples and voice notes',
    extensions: ['.mp3', '.wav', '.flac', '.aac', '.m4a', '.m4b', '.ogg', '.oga', '.opus', '.wma', '.aiff', '.aif', '.aifc', '.amr', '.mid', '.midi', '.am', '.mod', '.s3m', '.xm'],
  },
  {
    id: 'video',
    label: 'video',
    hint: 'recordings, clips and screen captures',
    extensions: [
      '.mp4', '.m4v', '.mpg', '.mpeg', '.mpe', '.mkv', '.mk3d', '.avi', '.mov', '.qt', '.wmv', '.asf', '.flv',
      '.f4v', '.webm', '.mts', '.m2ts', '.m2v', '.3gp', '.3g2', '.ogv', '.rmvb', '.vob', '.divx', '.mxf',
    ],
  },
  {
    id: 'archives',
    label: 'archives & disk images',
    hint: 'compressed containers, images and virtual disks',
    extensions: [
      '.zip', '.zipx', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.tbz2', '.xz', '.txz', '.zst', '.lz', '.lzma',
      '.z', '.cab', '.arj', '.lzh', '.zpaq', '.jar', '.war', '.ear', '.apk', '.ipa', '.xapk',
      '.iso', '.img', '.bin', '.cue', '.mdf', '.nrg', '.mds', '.vhd', '.vhdx', '.vmdk', '.vdi', '.qcow', '.qcow2', '.wim', '.esd', '.squashfs',
    ],
  },
  {
    id: 'code',
    label: 'code & config',
    hint: 'sources, scripts, notebooks and manifests',
    extensions: [
      '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.map', '.json', '.jsonc', '.json5', '.ndjson',
      '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.env', '.xml', '.xsd', '.xsl', '.dtd',
      '.html', '.htm', '.xhtml', '.css', '.scss', '.sass', '.less', '.styl', '.vue', '.svelte', '.astro',
      '.py', '.pyi', '.pyw', '.pyc', '.rb', '.rake', '.php', '.go', '.rs', '.java', '.kt', '.kts', '.scala',
      '.groovy', '.swift', '.m', '.mm', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.cs', '.fs',
      '.fsx', '.vb', '.vbs', '.bas', '.pas', '.pl', '.pm', '.lua', '.r', '.jl', '.clj', '.ex', '.exs', '.erl',
      '.hs', '.ml', '.mli', '.dart', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.bat', '.cmd', '.sql',
      '.ipynb', '.gradle', '.mk', '.cmake', '.plist', '.desktop', '.service', '.proto', '.graphql', '.gql',
    ],
  },
  {
    id: 'executables',
    label: 'executables',
    hint: 'programs that run on their own',
    extensions: ['.exe', '.com', '.scr', '.pif', '.msp', '.run', '.appimage', '.snap', '.flatpak', '.out', '.ko'],
  },
  {
    id: 'system',
    label: 'system & libraries',
    hint: 'drivers, shared libraries and OS plumbing',
    extensions: [
      '.dll', '.so', '.dylib', '.lib', '.a', '.o', '.obj', '.sys', '.drv', '.ocx', '.cpl', '.efi', '.elf',
      '.inf', '.ino', '.cat', '.mui', '.nls', '.manifest', '.reg', '.lnk', '.url', '.appref-ms',
      '.msixmanifest', '.local',
    ],
  },
  {
    id: 'installers',
    label: 'installers',
    hint: 'packages and bundles that install software',
    extensions: ['.msi', '.msix', '.appx', '.appxbundle', '.deb', '.rpm', '.pkg', '.dmg', '.nupkg', '.whl', '.vsix', '.crx', '.xpi', '.pak', '.setup'],
  },
  {
    id: 'fonts',
    label: 'fonts',
    hint: 'typefaces',
    extensions: ['.ttf', '.otf', '.ttc', '.otc', '.woff', '.woff2', '.eot', '.fon', '.pfb', '.pfa', '.pfm'],
  },
  {
    id: 'databases',
    label: 'databases',
    hint: 'local databases and index files',
    extensions: ['.db', '.db3', '.sqlite', '.sqlite3', '.mdb', '.accdb', '.dbf', '.sdf', '.ldf', '.laccdb', '.edb', '.sst', '.ldb', '.idx', '.pack', '.realm'],
  },
  {
    id: 'temporary',
    label: 'temporary & leftovers',
    hint: 'partial downloads, logs and backups nobody pruned',
    extensions: [
      '.tmp', '.temp', '.part', '.partial', '.crdownload', '.download', '.opdownload', '.!ut', '.bak', '.bk',
      '.bkp', '.old', '.orig', '.rej', '.log', '.etl', '.evtx', '.dmp', '.mdmp', '.hprof', '.swp', '.swo',
      '.swn', '.lock', '.pid', '.seed', '.cache', '.ds_store', '.~',
    ],
  },
];

/** First definition wins, so an extension listed twice can never move between buckets. */
const EXTENSION_OWNER = new Map();
for (const def of TYPOLOGY_DEFS) {
  for (const ext of def.extensions) {
    if (!EXTENSION_OWNER.has(ext)) EXTENSION_OWNER.set(ext, def.id);
  }
}

export const TYPOLOGIES = Object.freeze(
  TYPOLOGY_DEFS.map((def) =>
    Object.freeze({ id: def.id, label: def.label, hint: def.hint, extensions: Object.freeze([...def.extensions]) }),
  ),
);

export const UNKNOWN_TYPOLOGY = Object.freeze({
  id: 'unknown',
  label: 'other / no extension',
  hint: 'the extension is missing or unknown, so the file could not be bucketed',
  extensions: Object.freeze([]),
});

const TYPOLOGY_BY_ID = new Map([...TYPOLOGIES, UNKNOWN_TYPOLOGY].map((typology) => [typology.id, typology]));

export function typologyById(id) {
  return TYPOLOGY_BY_ID.get(id) ?? UNKNOWN_TYPOLOGY;
}

/** Trailing extension, lowercased, or a placeholder when the name has none. */
export function extensionOf(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const match = /(\.[A-Za-z0-9_+-]{1,12})$/.exec(base);
  return match ? match[1].toLowerCase() : '(none)';
}

/** Buckets a path by the first folder below the deepest matching scan root. */
export function folderOf(filePath, roots = []) {
  const target = String(filePath);
  const lower = target.toLowerCase();
  let best = null;

  for (const root of roots) {
    const raw = String(root).replace(/[\\/]+$/, '');
    const prefix = raw.toLowerCase();
    if (!prefix || !lower.startsWith(prefix)) continue;
    if (lower.length > prefix.length && !'\\/'.includes(lower[prefix.length])) continue;
    if (!best || prefix.length > best.length) best = raw;
  }
  if (!best) return '(outside roots)';

  const relative = target.slice(best.length).split(/[\\/]/).filter(Boolean);
  if (relative.length < 2) return `<${best.split(/[\\/]/).pop() ?? 'root'}>`;
  return relative[0];
}

/**
 * Pure: which bucket a file belongs to, from its name alone.
 * The `known` flag tells the UI when the extension is simply not in the taxonomy.
 */
export function classifyFile(file) {
  const name = file?.name ?? path.basename(String(file?.path ?? ''));
  const ext = extensionOf(name);
  const owner = EXTENSION_OWNER.get(ext);
  return { typology: owner ?? UNKNOWN_TYPOLOGY.id, ext, known: Boolean(owner) };
}

function newBucket(id) {
  return {
    id,
    files: 0,
    bytes: 0,
    extensions: new Map(),
    folders: new Map(),
    largest: null,
    newest: null,
    oldest: null,
  };
}

function tally(map, key, file) {
  const entry = map.get(key) ?? { files: 0, bytes: 0 };
  entry.files += 1;
  entry.bytes += file.size;
  map.set(key, entry);
}

function fileRef(file) {
  return { name: file.name, path: file.path, size: file.size, modifiedAt: file.modifiedAt ?? '' };
}

function stamp(ref) {
  return ref.modifiedAt ?? '';
}

/** Folds to the newer of two files; ties keep the incumbent so the answer is stable. */
function byTime(a, b) {
  if (!a) return b;
  if (!b) return a;
  return stamp(b).localeCompare(stamp(a)) > 0 ? b : a;
}

/** Folds to the older of two files; ties break on the path so the answer is stable. */
function byAge(a, b) {
  if (!a) return b;
  if (!b) return a;
  const delta = stamp(a).localeCompare(stamp(b));
  if (delta !== 0) return delta < 0 ? a : b;
  return collator.compare(a.path, b.path) <= 0 ? a : b;
}

/** Folds to the heavier of two files; ties keep the more recent one. */
function bySize(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.size !== b.size) return b.size > a.size ? b : a;
  return stamp(b).localeCompare(stamp(a)) >= 0 ? b : a;
}

/** Folds per-bucket maps into one, so the global charts never double count. */
function merge(target, source) {
  for (const [key, entry] of source) {
    const merged = target.get(key) ?? { files: 0, bytes: 0 };
    merged.files += entry.files;
    merged.bytes += entry.bytes;
    target.set(key, merged);
  }
  return target;
}

/** The heaviest `limit` keys, each under the name the table shows. */
export function topEntries(map, limit, key) {
  return [...map.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes || collator.compare(a[0], b[0]))
    .slice(0, limit)
    .map(([label, entry]) => ({ [key]: label, files: entry.files, bytes: entry.bytes }));
}

/**
 * Read-only census of the file typologies under the configured roots.
 *
 * One pass over the tree, and the only work per file is reading its size and
 * bucketing its name: no hashing, no file contents are opened at all. That keeps a
 * full home folder affordable and means the answer is decided by the extension a
 * file carries, exactly like Explorer shows it.
 *
 * Emits `update` with `{ status, result }` on every transition and on throttled
 * progress ticks, so the HTTP layer can push straight to the browser.
 */
export class TypologyScanner extends EventEmitter {
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
      classified: 0,
      unreadable: 0,
      skippedDirs: 0,
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
    if (this.#running) throw new Error('a typology scan is already running');
    this.scan().catch((error) => {
      this.logger.error?.(`typology scan failed: ${error.message}`);
    });
    return this.getStatus();
  }

  async scan() {
    if (this.#running) throw new Error('a typology scan is already running');
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
      classified: 0,
      unreadable: 0,
      skippedDirs: 0,
      truncated: false,
      error: null,
    };
    this.#emitUpdate(true);

    const startedAt = Date.now();
    try {
      const files = await this.#walk();
      if (this.#cancelled) return this.#finish(startedAt, 'cancelled');

      this.#status.phase = 'classifying';
      this.#status.filesSeen = files.length;
      this.#emitUpdate(true);

      this.#result = this.#buildResult(files, startedAt);
      return this.#finish(startedAt, 'done');
    } catch (error) {
      this.#status.error = error.message;
      this.logger.error?.(`typology scan failed: ${error.message}`);
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

  async #walk() {
    const { roots, maxFiles, maxDepth, minSizeBytes, maxFileBytes, concurrency } = this.config;
    const { files, unreadable, skippedDirs, truncated } = await walkFiles({
      roots,
      exclude: [...this.#exclude],
      maxFiles,
      maxDepth,
      concurrency,
      minSizeBytes,
      maxFileBytes,
      isCancelled: () => this.#cancelled,
      onProgress: (count) => {
        this.#status.filesSeen = count;
        this.#emitUpdate();
      },
      onUnreadable: (where, error) => {
        this.#status.unreadable += 1;
        if (!isExpectedUnreadable(error)) {
          this.logger.warn?.(`typology scan skipped ${where}: ${error.code ?? error.message}`);
        }
      },
    });

    this.#status.filesSeen = files.length;
    this.#status.unreadable = unreadable;
    this.#status.skippedDirs = skippedDirs;
    this.#status.truncated = truncated;
    this.#emitUpdate();
    return files;
  }

  #buildResult(files, startedAt) {
    const { topExtensions = 20, topFolders = 20 } = this.config;
    const roots = [...this.#status.roots];
    const buckets = new Map(TYPOLOGIES.map((typology) => [typology.id, newBucket(typology.id)]));
    buckets.set(UNKNOWN_TYPOLOGY.id, newBucket(UNKNOWN_TYPOLOGY.id));
    let bytes = 0;
    let newest = null;
    let oldest = null;

    for (const file of files) {
      const { typology, ext } = classifyFile(file);
      const bucket = buckets.get(typology) ?? buckets.get(UNKNOWN_TYPOLOGY.id);
      const folder = folderOf(file.path, roots);

      bucket.files += 1;
      bucket.bytes += file.size;
      tally(bucket.extensions, ext, file);
      tally(bucket.folders, folder, file);
      bytes += file.size;

      const ref = fileRef(file);
      bucket.largest = bySize(bucket.largest, ref);
      bucket.newest = byTime(bucket.newest, ref);
      bucket.oldest = byAge(bucket.oldest, ref);
      newest = byTime(newest, ref);
      oldest = byAge(oldest, ref);

      this.#status.classified += 1;
      if (this.#status.classified % PROGRESS_EVERY === 0) this.#emitUpdate();
    }

    const allExtensions = new Map();
    const allFolders = new Map();
    for (const bucket of buckets.values()) {
      merge(allExtensions, bucket.extensions);
      merge(allFolders, bucket.folders);
    }

    const typologies = [...buckets.values()]
      .map((bucket) => {
        const typology = typologyById(bucket.id);
        return {
          id: bucket.id,
          label: typology.label,
          hint: typology.hint,
          files: bucket.files,
          bytes: bucket.bytes,
          share: bytes > 0 ? bucket.bytes / bytes : 0,
          largest: bucket.largest,
          newest: bucket.newest,
          oldest: bucket.oldest,
          extensions: topEntries(bucket.extensions, topExtensions, 'ext'),
          folders: topEntries(bucket.folders, topFolders, 'folder'),
        };
      })
      .sort((a, b) => b.bytes - a.bytes || collator.compare(a.label, b.label));

    const unknown = typologies.find((row) => row.id === UNKNOWN_TYPOLOGY.id) ?? { files: 0, bytes: 0 };

    return {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      roots,
      totals: {
        files: files.length,
        bytes,
        typologies: typologies.filter((row) => row.files > 0).length,
        extensions: allExtensions.size,
        folders: allFolders.size,
        unknownFiles: unknown.files,
        unknownBytes: unknown.bytes,
      },
      typologies,
      topExtensions: topEntries(allExtensions, topExtensions, 'ext'),
      topFolders: topEntries(allFolders, topFolders, 'folder'),
      newestFile: newest,
      oldestFile: oldest,
    };
  }

  #emitUpdate(force = false) {
    const now = Date.now();
    if (!force && now - this.#progressAt < PROGRESS_INTERVAL_MS) return;
    this.#progressAt = now;
    this.emit('update', this.snapshot());
  }
}