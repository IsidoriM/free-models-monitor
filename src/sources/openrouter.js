import { createHttpClient, createTtlCache, mapLimit } from '../core/http.js';
import { isFreeModel } from '../core/normalize.js';

const BASE_URL = 'https://openrouter.ai/api/v1';
const CATALOG_URL = `${BASE_URL}/models`;

/** The details route needs literal slashes, so encode per character, not per segment. */
function encodeSlug(slug) {
  return encodeURIComponent(String(slug))
    .replace(/%2F/gi, '/')
    .replace(/%3A/gi, ':');
}

export function createOpenRouterSource(config) {
  const http = createHttpClient({
    timeoutMs: config.requestTimeoutMs,
    minGapMs: config.minRequestGapMs,
    userAgent: 'free-models-monitor/1.0',
  });
  const endpointCache = createTtlCache(config.endpointCacheTtlMs);
  const headers = { 'http-referer': 'http://localhost/free-models-monitor', 'x-title': 'Free Models Monitor' };

  async function fetchCatalog() {
    const payload = await http.get(CATALOG_URL, { headers });
    const models = Array.isArray(payload?.data) ? payload.data : [];
    return {
      fetchedAt: new Date().toISOString(),
      total: models.length,
      free: models.filter(isFreeModel),
    };
  }

  async function fetchEndpoints(slug, { refresh = false } = {}) {
    if (!refresh) {
      const cached = endpointCache.get(slug);
      if (cached !== undefined) return cached;
    }
    const payload = await http.get(`${BASE_URL}/models/${encodeSlug(slug)}/endpoints`, { headers });
    const endpoints = Array.isArray(payload?.data?.endpoints) ? payload.data.endpoints : [];
    return endpointCache.set(slug, endpoints);
  }

  /**
   * Fetches the free catalog plus provider telemetry. Endpoint payloads are
   * TTL-cached, so a normal poll cycle only pays for what actually changed.
   */
  async function collectFreeModels({ concurrency = config.concurrency, refresh = false } = {}) {
    const catalog = await fetchCatalog();
    const settled = await mapLimit(catalog.free, concurrency, (raw) =>
      fetchEndpoints(raw.canonical_slug ?? raw.id, { refresh }),
    );

    const models = [];
    const failures = [];
    settled.forEach((result, index) => {
      const raw = catalog.free[index];
      if (result.ok) {
        models.push({ raw, endpoints: result.value });
      } else {
        failures.push({
          id: raw.id,
          error: result.error?.message ?? 'unknown error',
          status: result.error?.status ?? null,
        });
      }
    });

    return {
      models,
      failures,
      catalog: {
        totalModels: catalog.total,
        freeModels: catalog.free.length,
        resolvedModels: models.length,
        cachedEndpoints: endpointCache.size,
        fetchedAt: catalog.fetchedAt,
      },
    };
  }

  async function probeCompletion({ model, prompt, maxTokens }) {
    const payload = await http.post(
      `${BASE_URL}/chat/completions`,
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
      },
      { headers: { ...headers, authorization: `Bearer ${config.probe.apiKey}` } },
    );
    const choice = payload?.choices?.[0]?.message?.content ?? '';
    return { ok: typeof choice === 'string', sample: choice.slice(0, 80) };
  }

  return {
    name: 'openrouter',
    fetchCatalog,
    fetchEndpoints,
    collectFreeModels,
    probeCompletion,
    clearCache: () => endpointCache.clear(),
    get cacheSize() {
      return endpointCache.size;
    },
  };
}