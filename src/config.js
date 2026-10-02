import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..');

try {
  process.loadEnvFile(path.join(rootDir, '.env'));
} catch {
  // no .env present, environment variables are enough
}

function int(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function text(value, fallback) {
  return value === undefined || value === '' ? fallback : String(value);
}

/** Semicolon separated env var -> trimmed, non-empty entries. */
function list(value, fallback) {
  const source = value === undefined || value === '' ? fallback : value;
  return String(source)
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const dataDir = path.resolve(rootDir, text(process.env.DATA_DIR, 'data'));
const apiKey = text(process.env.OPENROUTER_API_KEY, '');

/**
 * Directory names skipped by the read-only scanners. These hold caches, build
 * artefacts and virtual filesystems: walking them wastes minutes and floods the
 * report with noise nobody would ever act on by hand.
 */
export const SCAN_EXCLUDE_DEFAULT = [
  'AppData',
  '$Recycle.Bin',
  'System Volume Information',
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.npm',
  '.yarn',
  '.pnpm-store',
  '.gradle',
  '.m2',
  '.nuget',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.parcel-cache',
  '.DS_Store',
];

/**
 * Directory names skipped by the trojan scanner too: the same caches, build artefacts
 * and virtual filesystems, which would bury a handful of real suspects in noise.
 */
export const TROJAN_EXCLUDE_DEFAULT = [...SCAN_EXCLUDE_DEFAULT];

/**
 * The typology census shares the same skips: caches, build artefacts and virtual
 * filesystems describe the tooling, not the files a person keeps.
 */
export const TYPOLOGY_EXCLUDE_DEFAULT = [...SCAN_EXCLUDE_DEFAULT];

const homeDir = os.homedir();
const tempDir = text(process.env.TEMP, '') || os.tmpdir();
const startupDir = path.join(homeDir, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');

export const config = {
  rootDir,
  publicDir: path.join(rootDir, 'public'),
  dataDir,
  persist: !bool(process.env.DISABLE_PERSIST, false),

  host: text(process.env.HOST, '127.0.0.1'),
  port: int(process.env.PORT, 8787),

  topN: Math.max(1, int(process.env.TOP_N, 20)),
  pollIntervalMs: Math.max(5_000, int(process.env.POLL_INTERVAL_MS, 60_000)),
  historySize: Math.max(10, int(process.env.HISTORY_SIZE, 180)),
  concurrency: Math.max(1, int(process.env.CONCURRENCY, 6)),
  requestTimeoutMs: Math.max(1_000, int(process.env.REQUEST_TIMEOUT_MS, 15_000)),
  endpointCacheTtlMs: Math.max(0, int(process.env.ENDPOINT_CACHE_TTL_MS, 300_000)),
  minRequestGapMs: Math.max(0, int(process.env.MIN_REQUEST_GAP_MS, 120)),

  probe: {
    enabled: bool(process.env.PROBE_ENABLED, false) && apiKey !== '',
    apiKey,
    topN: Math.max(1, int(process.env.PROBE_TOP_N, 5)),
    everyCycles: Math.max(1, int(process.env.PROBE_EVERY_CYCLES, 10)),
    maxTokens: Math.max(1, int(process.env.PROBE_MAX_TOKENS, 8)),
  },

  trojans: {
    enabled: bool(process.env.TROJANS_ENABLED, true),
    roots: list(process.env.TROJAN_ROOTS, homeDir),
    exclude: list(process.env.TROJAN_EXCLUDE, TROJAN_EXCLUDE_DEFAULT),
    // Where a payload usually lands: anything runnable in there is worth a second look.
    hotDirs: list(process.env.TROJAN_HOT_DIRS, [path.join(homeDir, 'Downloads'), path.join(homeDir, 'Desktop'), tempDir].join(';')),
    hotDirNames: list(process.env.TROJAN_HOT_DIR_NAMES, 'Downloads;Desktop'),
    startupDirs: list(process.env.TROJAN_STARTUP_DIRS, startupDir),
    minSizeBytes: Math.max(1, int(process.env.TROJAN_MIN_SIZE_BYTES, 1)),
    maxFileBytes: Math.max(0, int(process.env.TROJAN_MAX_FILE_BYTES, 536_870_912)),
    // Files above this are still listed by name rules but their bytes are not read.
    maxInspectBytes: Math.max(0, int(process.env.TROJAN_MAX_INSPECT_BYTES, 67_108_864)),
    maxFiles: Math.max(1_000, int(process.env.TROJAN_MAX_FILES, 750_000)),
    maxDepth: Math.max(1, int(process.env.TROJAN_MAX_DEPTH, 12)),
    concurrency: Math.max(1, int(process.env.TROJAN_CONCURRENCY, 8)),
    topFindings: Math.max(1, int(process.env.TROJAN_TOP_FINDINGS, 300)),
    recentDays: Math.max(0, int(process.env.TROJAN_RECENT_DAYS, 30)),
  },

  typologies: {
    enabled: bool(process.env.TYPOLOGIES_ENABLED, true),
    roots: list(process.env.TYPOLOGY_ROOTS, homeDir),
    exclude: list(process.env.TYPOLOGY_EXCLUDE, TYPOLOGY_EXCLUDE_DEFAULT),
    // A census wants every file, including empty placeholders, so no size floor by default.
    minSizeBytes: Math.max(0, int(process.env.TYPOLOGY_MIN_SIZE_BYTES, 0)),
    maxFileBytes: Math.max(0, int(process.env.TYPOLOGY_MAX_FILE_BYTES, 0)),
    maxFiles: Math.max(1_000, int(process.env.TYPOLOGY_MAX_FILES, 750_000)),
    maxDepth: Math.max(1, int(process.env.TYPOLOGY_MAX_DEPTH, 12)),
    concurrency: Math.max(1, int(process.env.TYPOLOGY_CONCURRENCY, 8)),
    topExtensions: Math.max(1, int(process.env.TYPOLOGY_TOP_EXTENSIONS, 20)),
    topFolders: Math.max(1, int(process.env.TYPOLOGY_TOP_FOLDERS, 20)),
  },
};

export const SCORING_WEIGHTS = Object.freeze({
  availability: 0.3,
  capability: 0.25,
  context: 0.15,
  features: 0.12,
  recency: 0.1,
  breadth: 0.08,
});

export const CONTEXT_SCORE_CEILING = 2_000_000;
export const RECENCY_HALF_LIFE_DAYS = 45;
export const EXPIRING_SOON_DAYS = 7;