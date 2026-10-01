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
 * Directory names skipped by the duplicate scanner. These hold caches, build
 * artefacts and virtual filesystems: scanning them wastes minutes and floods
 * the report with copies nobody would ever delete by hand.
 */
export const DUPLICATE_EXCLUDE_DEFAULT = [
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

  duplicates: {
    enabled: bool(process.env.DUPLICATES_ENABLED, true),
    roots: list(process.env.DUPLICATE_ROOTS, os.homedir()),
    exclude: list(process.env.DUPLICATE_EXCLUDE, DUPLICATE_EXCLUDE_DEFAULT),
    minSizeBytes: Math.max(1, int(process.env.DUPLICATE_MIN_SIZE_BYTES, 1024)),
    maxFileBytes: Math.max(0, int(process.env.DUPLICATE_MAX_FILE_BYTES, 536_870_912)),
    maxFiles: Math.max(1_000, int(process.env.DUPLICATE_MAX_FILES, 750_000)),
    maxDepth: Math.max(1, int(process.env.DUPLICATE_MAX_DEPTH, 12)),
    concurrency: Math.max(1, int(process.env.DUPLICATE_CONCURRENCY, 6)),
    topGroups: Math.max(1, int(process.env.DUPLICATE_TOP_GROUPS, 300)),
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