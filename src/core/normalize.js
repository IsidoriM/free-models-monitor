import {
  CONTEXT_SCORE_CEILING,
  EXPIRING_SOON_DAYS,
  RECENCY_HALF_LIFE_DAYS,
  SCORING_WEIGHTS,
} from '../config.js';

const DAY_MS = 86_400_000;

export const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const price = (value) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Accepts unix seconds, or an ISO/date string like `2026-10-05`. */
const toIso = (value) => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
};

/** OpenRouter reports prompt/completion price per token; 0 means genuinely free. */
export function isFreeModel(raw) {
  const prompt = price(raw?.pricing?.prompt);
  const completion = price(raw?.pricing?.completion);
  if (prompt === 0 && completion === 0) return true;
  return typeof raw?.id === 'string' && raw.id.endsWith(':free');
}

export function isFreeEndpoint(endpoint) {
  const prompt = price(endpoint?.pricing?.prompt);
  const completion = price(endpoint?.pricing?.completion);
  return prompt === 0 && completion === 0;
}

export function normalizeEndpoint(raw) {
  const status = num(raw?.status);
  const latency = num(raw?.latency_last_30m);
  const throughput = num(raw?.throughput_last_30m);
  return {
    provider: raw?.provider_name ?? raw?.name ?? 'unknown',
    tag: raw?.tag ?? null,
    quantization: raw?.quantization ?? null,
    free: isFreeEndpoint(raw),
    live: status === 0,
    status,
    uptime5m: num(raw?.uptime_last_5m),
    uptime30m: num(raw?.uptime_last_30m),
    uptime1d: num(raw?.uptime_last_1d),
    latencyMs: latency !== null && latency > 0 ? Math.round(latency * 1000) : null,
    throughputTps: throughput !== null && throughput > 0 ? Math.round(throughput) : null,
    contextLength: num(raw?.context_length),
    maxCompletionTokens: num(raw?.max_completion_tokens),
  };
}

function summarizeEndpoints(endpoints) {
  const free = endpoints.filter((endpoint) => endpoint.free);
  const liveFree = free.filter((endpoint) => endpoint.live);

  const bestOf = (pick) => {
    const values = liveFree.map(pick).filter((value) => value !== null);
    return values.length ? Math.max(...values) : null;
  };
  const avgOf = (pick) => {
    const values = liveFree.map(pick).filter((value) => value !== null);
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };

  return {
    total: endpoints.length,
    free: free.length,
    liveFree: liveFree.length,
    freeProviders: [...new Set(free.map((endpoint) => endpoint.provider))].sort(),
    bestUptime5m: bestOf((endpoint) => endpoint.uptime5m),
    avgUptime5m: avgOf((endpoint) => endpoint.uptime5m),
    bestUptime30m: bestOf((endpoint) => endpoint.uptime30m),
    bestUptime1d: bestOf((endpoint) => endpoint.uptime1d),
    bestLatencyMs: bestOf((endpoint) => endpoint.latencyMs) ?? null,
    bestThroughputTps: bestOf((endpoint) => endpoint.throughputTps),
  };
}

function daysBetween(from, to) {
  return (to - from) / DAY_MS;
}

export function availabilityScore(summary) {
  if (summary.liveFree === 0) {
    return { value: 0, basis: 'no-live-free-endpoint' };
  }
  const pct = (value) => (value === null ? null : clamp(value / 100));
  const last5m = pct(summary.bestUptime5m) ?? 0.5;
  const last30m = pct(summary.bestUptime30m) ?? 0.5;
  const last1d = pct(summary.bestUptime1d) ?? 0.5;
  // 3000ms down to 300ms maps to 0..1; unknown latency is treated as neutral.
  const speed = summary.bestLatencyMs === null ? 0.5 : clamp((3000 - summary.bestLatencyMs) / 2600);
  const value = clamp(
    0.35 * last5m + 0.25 * last30m + 0.2 * last1d + 0.1 * speed + 0.1 * clamp(summary.liveFree / 3),
  );
  return { value, basis: 'uptime+latency' };
}

export function capabilityScore(model) {
  const aa = model.benchmarks;
  if (aa && Number.isFinite(aa.intelligence)) {
    const value = clamp(
      0.6 * clamp(aa.intelligence / 100) +
        0.25 * clamp((Number.isFinite(aa.coding) ? aa.coding : aa.intelligence) / 100) +
        0.15 * clamp((Number.isFinite(aa.agentic) ? aa.agentic : aa.intelligence) / 100),
    );
    return { value, basis: 'artificial-analysis' };
  }
  // Unbenchmarked models sit at a neutral 0.4 so they are ranked, not discarded.
  return { value: 0.4, basis: 'neutral-estimate' };
}

export function contextScore(contextLength) {
  if (!contextLength || contextLength <= 0) return 0;
  return clamp(Math.log10(contextLength) / Math.log10(CONTEXT_SCORE_CEILING));
}

export function featureScore(model) {
  const params = new Set(model.supportedParameters ?? []);
  let value = 0;
  if (params.has('tools') || params.has('tool_choice')) value += 0.35;
  if (params.has('structured_outputs') || params.has('response_format')) value += 0.2;
  if (params.has('reasoning') || params.has('reasoning_effort')) value += 0.25;
  if ((model.inputModalities ?? ['text']).length > 1) value += 0.2;
  return clamp(value);
}

/** Adjacent to, or past, its free-tier expiry date. */
export function expiryState(expiresAt, now = Date.now()) {
  if (!expiresAt) return { state: 'none', daysLeft: null, factor: 1 };
  const daysLeft = daysBetween(now, Date.parse(expiresAt));
  if (daysLeft <= 0) return { state: 'expired', daysLeft, factor: 0 };
  if (daysLeft <= EXPIRING_SOON_DAYS) return { state: 'expiring', daysLeft, factor: 0.55 };
  return { state: 'active', daysLeft, factor: 1 };
}

export function recencyScore(createdAt, now) {
  if (!createdAt) return 0.5;
  const ageDays = Math.max(0, daysBetween(Date.parse(createdAt), now));
  return clamp(Math.exp((-Math.LN2 * ageDays) / RECENCY_HALF_LIFE_DAYS));
}

export function breadthScore(summary) {
  return clamp(summary.liveFree / 3);
}

function expiryFactor(expiresAt, now) {
  const { factor, state, daysLeft } = expiryState(expiresAt, now);
  return { factor, state, daysLeft };
}

/**
 * Turns a raw catalog entry plus its provider endpoints into a scored,
 * dashboard-ready model. Pure: same inputs always produce the same output.
 */
export function normalizeModel(raw, { endpoints = [], now = Date.now() } = {}) {
  const normalizedEndpoints = endpoints.map(normalizeEndpoint);
  const summary = summarizeEndpoints(normalizedEndpoints);
  const architecture = raw?.architecture ?? {};
  const aa = raw?.benchmarks?.artificial_analysis ?? {};

  const model = {
    id: raw.id,
    slug: raw.canonical_slug ?? raw.id,
    name: raw.name ?? raw.id,
    description: raw.description ?? '',
    providerFamily: String(raw.id ?? '').split('/')[0] ?? null,
    createdAt: toIso(raw.created),
    expiresAt: toIso(raw.expiration_date),
    contextLength: num(raw.context_length),
    maxOutputTokens: num(raw.top_provider?.max_completion_tokens),
    moderated: raw.top_provider?.is_moderated ?? null,
    modality: architecture.modality ?? null,
    inputModalities: architecture.input_modities ?? ['text'],
    outputModalities: architecture.output_modities ?? ['text'],
    tokenizer: architecture.tokenizer ?? null,
    huggingFaceId: raw.hugging_face_id ?? null,
    supportedParameters: Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [],
    reasoning: raw.reasoning ?? null,
    perRequestLimits: raw.per_request_limits ?? null,
    benchmarks: {
      intelligence: num(aa.intelligence_index),
      coding: num(aa.coding_index),
      agentic: num(aa.agentic_index),
    },
    url: `https://openrouter.ai/${raw.id}`,
    endpoints: normalizedEndpoints,
    telemetry: summary,
  };

const expiry = expiryFactor(model.expiresAt, now);
  const availability = availabilityScore(summary);
  const capability = capabilityScore(model);
  const components = {
    availability: availability.value,
    capability: capability.value,
    context: contextScore(model.contextLength),
    features: featureScore(model),
    recency: recencyScore(model.createdAt, now),
    breadth: breadthScore(summary),
  };

  let weighted = 0;
  for (const [key, weight] of Object.entries(SCORING_WEIGHTS)) {
    weighted += (components[key] ?? 0) * weight;
  }

  model.score = Math.round(clamp(weighted * expiry.factor) * 1000) / 10;
  model.components = Object.fromEntries(
    Object.entries(components).map(([key, value]) => [key, Math.round(value * 1000) / 10]),
  );
  model.scoringBasis = {
    availability: availability.basis,
    capability: capability.basis,
  };
  model.estimatedCapability = capability.basis !== 'artificial-analysis';
  model.expiry = {
    state: expiry.state,
    daysLeft: expiry.daysLeft === null ? null : Math.round(expiry.daysLeft),
  };
  model.status = summary.liveFree > 0 ? (expiry.state === 'expired' ? 'expired' : 'live') : 'unavailable';
  model.fetchedAt = new Date(now).toISOString();
  return model;
}

/** Ranks models, dropping expired ones, and returns at most `limit` entries. */
export function rankModels(models, limit = 20) {
  return [...models]
    .filter((model) => model.status !== 'expired')
    .sort((a, b) => b.score - a.score || b.telemetry.liveFree - a.telemetry.liveFree || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((model, index) => ({ ...model, rank: index + 1 }));
}