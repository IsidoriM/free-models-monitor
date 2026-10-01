import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Creates a JSON-over-HTTP client with a hard timeout, bounded retries and a
 * minimum gap between calls so we never hammer the upstream API.
 */
export function createHttpClient({
  timeoutMs = 15_000,
  retries = 2,
  retryBaseDelayMs = 400,
  minGapMs = 120,
  userAgent = 'free-models-monitor/1.0',
} = {}) {
  let lastStartedAt = 0;
  let chain = Promise.resolve();

  async function fetchJson(url, { headers = {}, method = 'GET', body = null } = {}) {
    const attempt = async () => {
      const now = Date.now();
      const waitFor = Math.max(0, minGapMs - (now - lastStartedAt));
      lastStartedAt = now + waitFor;
      if (waitFor > 0) await sleep(waitFor);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      try {
        const response = await fetch(url, {
          method,
          signal: controller.signal,
          headers: {
            accept: 'application/json',
            'user-agent': userAgent,
            ...headers,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const text = await response.text();
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status} ${response.statusText}`);
          error.status = response.status;
          error.url = url;
          error.body = text.slice(0, 500);
          throw error;
        }
        try {
          return JSON.parse(text);
        } catch (cause) {
          throw new Error(`invalid JSON from ${url}`, { cause });
        }
      } finally {
        clearTimeout(timer);
      }
    };

    let lastError;
    for (let i = 0; i <= retries; i += 1) {
      try {
        return await attempt();
      } catch (error) {
        lastError = error;
        const retriable = error.status === undefined || error.status === 429 || error.status >= 500;
        if (!retriable || i === retries) break;
        await sleep(retryBaseDelayMs * 2 ** i);
      }
    }
    throw lastError;
  }

  return {
    get: (url, options) => fetchJson(url, options),
    post: (url, body, options) => fetchJson(url, { ...options, method: 'POST', body }),
  };
}

/** Runs tasks with a bounded number in flight, preserving input order. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/** Tiny TTL cache; stale entries are dropped on read. */
export function createTtlCache(ttlMs, now = () => Date.now()) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.storedAt > ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      entries.set(key, { value, storedAt: now() });
      return value;
    },
    has(key) {
      return this.get(key) !== undefined;
    },
    delete(key) {
      return entries.delete(key);
    },
    get size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}