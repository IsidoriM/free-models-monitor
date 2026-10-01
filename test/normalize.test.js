import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  availabilityScore,
  breadthScore,
  capabilityScore,
  clamp,
  contextScore,
  featureScore,
  isFreeEndpoint,
  isFreeModel,
  normalizeEndpoint,
  normalizeModel,
  rankModels,
  recencyScore,
} from '../src/core/normalize.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-01T00:00:00Z');

const freeEndpoint = (overrides = {}) => ({
  provider_name: 'TestProvider',
  tag: 'test',
  quantization: 'fp8',
  status: 0,
  uptime_last_5m: 99.5,
  uptime_last_30m: 99,
  uptime_last_1d: 98,
  latency_last_30m: 1.2,
  throughput_last_30m: 40,
  context_length: 128_000,
  max_completion_tokens: 8_192,
  pricing: { prompt: '0', completion: '0' },
  ...overrides,
});

const paidEndpoint = freeEndpoint({ pricing: { prompt: '0.0000001', completion: '0.000002' } });

const freeCatalogEntry = (overrides = {}) => ({
  id: 'acme/awesome:free',
  canonical_slug: 'acme/awesome-20260601',
  name: 'Awesome (free)',
  created: Math.floor((NOW - 10 * DAY) / 1000),
  context_length: 200_000,
  description: 'A test model.',
  architecture: { modality: 'text->text', input_modities: ['text'], output_modalities: ['text'], tokenizer: 'Acme' },
  top_provider: { max_completion_tokens: 8_192, is_moderated: true },
  pricing: { prompt: '0', completion: '0' },
  supported_parameters: ['tools', 'temperature', 'reasoning'],
  benchmarks: { artificial_analysis: { intelligence_index: 40, coding_index: 50, agentic_index: 30 } },
  ...overrides,
});

describe('isFreeModel', () => {
  it('accepts zero prompt and completion pricing', () => {
    assert.equal(isFreeModel(freeCatalogEntry()), true);
  });

  it('accepts the :free suffix even when pricing is missing', () => {
    assert.equal(isFreeModel({ id: 'x/y:free', pricing: {} }), true);
  });

  it('rejects priced models', () => {
    assert.equal(isFreeModel({ id: 'x/y', pricing: { prompt: '0.000001', completion: '0.000002' } }), false);
  });

  it('rejects half-free models (free input, paid output)', () => {
    assert.equal(isFreeModel({ id: 'x/y', pricing: { prompt: '0', completion: '0.000001' } }), false);
  });
});

describe('isFreeEndpoint', () => {
  it('separates free from paid providers', () => {
    assert.equal(isFreeEndpoint(freeEndpoint()), true);
    assert.equal(isFreeEndpoint(paidEndpoint), false);
  });
});

describe('normalizeEndpoint', () => {
  it('converts latency from seconds to milliseconds', () => {
    assert.equal(normalizeEndpoint(freeEndpoint()).latencyMs, 1200);
  });

  it('treats only status 0 as live', () => {
    assert.equal(normalizeEndpoint(freeEndpoint()).live, true);
    assert.equal(normalizeEndpoint(freeEndpoint({ status: -2 })).live, false);
  });

  it('maps missing telemetry to null rather than zero', () => {
    const endpoint = normalizeEndpoint(freeEndpoint({ uptime_last_5m: null, latency_last_30m: null }));
    assert.equal(endpoint.uptime5m, null);
    assert.equal(endpoint.latencyMs, null);
  });
});

describe('normalizeModel', () => {
  it('produces a 0-100 score and rounded components', () => {
    const model = normalizeModel(freeCatalogEntry(), { endpoints: [freeEndpoint()], now: NOW });
    assert.ok(model.score > 0 && model.score <= 100);
    for (const value of Object.values(model.components)) {
      assert.ok(value >= 0 && value <= 100, `component out of range: ${value}`);
    }
  });

  it('reports live status and provider list', () => {
    const model = normalizeModel(freeCatalogEntry(), { endpoints: [freeEndpoint(), paidEndpoint], now: NOW });
    assert.equal(model.status, 'live');
    assert.equal(model.telemetry.liveFree, 1);
    assert.equal(model.telemetry.free, 1);
    assert.equal(model.telemetry.total, 2);
    assert.deepEqual(model.telemetry.freeProviders, ['TestProvider']);
  });

  it('marks a model unavailable when no free endpoint is live', () => {
    const model = normalizeModel(freeCatalogEntry(), { endpoints: [freeEndpoint({ status: -1 })], now: NOW });
    assert.equal(model.status, 'unavailable');
    assert.equal(model.components.availability, 0);
  });

  it('flags estimated capability when benchmarks are absent', () => {
    const model = normalizeModel(freeCatalogEntry({ benchmarks: undefined }), { endpoints: [freeEndpoint()], now: NOW });
    assert.equal(model.estimatedCapability, true);
    assert.equal(model.scoringBasis.capability, 'neutral-estimate');
  });

  it('penalises models about to expire and drops expired ones', () => {
    const soon = normalizeModel(freeCatalogEntry({ expiration_date: '2026-06-05' }), {
      endpoints: [freeEndpoint()],
      now: NOW,
    });
    const later = normalizeModel(freeCatalogEntry({ expiration_date: '2026-09-05' }), {
      endpoints: [freeEndpoint()],
      now: NOW,
    });
    assert.equal(soon.expiry.state, 'expiring');
    assert.ok(soon.score < later.score, 'expiring model should score lower');

    const expired = normalizeModel(freeCatalogEntry({ expiration_date: '2026-05-01' }), {
      endpoints: [freeEndpoint()],
      now: NOW,
    });
    assert.equal(expired.status, 'expired');
    assert.equal(expired.score, 0);
  });

  it('is deterministic for identical inputs', () => {
    const a = normalizeModel(freeCatalogEntry(), { endpoints: [freeEndpoint()], now: NOW });
    const b = normalizeModel(freeCatalogEntry(), { endpoints: [freeEndpoint()], now: NOW });
    assert.equal(a.score, b.score);
  });
});

describe('scoring components', () => {
  it('availability grows with uptime and live providers', () => {
    const healthy = availabilityScore({ liveFree: 3, bestUptime5m: 100, bestUptime30m: 100, bestUptime1d: 100, bestLatencyMs: 300 });
    const flaky = availabilityScore({ liveFree: 1, bestUptime5m: 80, bestUptime30m: 80, bestUptime1d: 80, bestLatencyMs: 2500 });
    assert.ok(healthy.value > flaky.value);
    assert.equal(availabilityScore({ liveFree: 0 }).value, 0);
  });

  it('capability prefers benchmarked models and stays neutral without data', () => {
    const benchmarked = capabilityScore({ benchmarks: { intelligence: 80, coding: 60, agentic: 50 } }, NOW);
    const plain = capabilityScore({ benchmarks: { intelligence: null, coding: null, agentic: null } });
    const empty = capabilityScore({ benchmarks: {} });
    assert.ok(benchmarked.value > plain.value);
    assert.equal(plain.value, 0.4);
    assert.equal(empty.value, 0.4);
    assert.equal(Number.isNaN(empty.value), false);
  });

  it('context is log-scaled against the ceiling', () => {
    assert.equal(contextScore(0), 0);
    assert.ok(contextScore(1_000_000) > contextScore(100_000));
    assert.ok(contextScore(2_000_000) <= 1);
  });

  it('features reward tools, reasoning and multimodal input', () => {
    const rich = featureScore({ supportedParameters: ['tools', 'reasoning', 'structured_outputs'], inputModalities: ['text', 'image'] });
    const bare = featureScore({ supportedParameters: [], inputModalities: ['text'] });
    assert.ok(rich > bare);
    assert.equal(bare, 0);
  });

  it('recency halves over the half-life', () => {
    const fresh = recencyScore(new Date(NOW - 5 * DAY).toISOString(), NOW);
    const old = recencyScore(new Date(NOW - 50 * DAY).toISOString(), NOW);
    assert.ok(fresh > old * 1.8, `${fresh} should clearly exceed ${old}`);
  });

  it('breadth saturates at three live providers', () => {
    assert.equal(breadthScore({ liveFree: 1 }), 1 / 3);
    assert.equal(breadthScore({ liveFree: 9 }), 1);
  });

  it('clamp keeps values in range', () => {
    assert.equal(clamp(5), 1);
    assert.equal(clamp(-5), 0);
  });
});

describe('rankModels', () => {
  const build = (id, score, status = 'live') => ({ id, score, status, telemetry: { liveFree: 1 } });

  it('sorts by score descending and assigns 1-based ranks', () => {
    const ranked = rankModels([build('a', 10), build('b', 90), build('c', 50)], 20);
    assert.deepEqual(
      ranked.map((model) => [model.id, model.rank]),
      [
        ['b', 1],
        ['c', 2],
        ['a', 3],
      ],
    );
  });

  it('respects the limit', () => {
    const models = Array.from({ length: 30 }, (_, index) => build(`m${index}`, 100 - index));
    assert.equal(rankModels(models, 20).length, 20);
  });

  it('excludes expired models', () => {
    const ranked = rankModels([build('gone', 100, 'expired'), build('here', 10)], 20);
    assert.deepEqual(
      ranked.map((model) => model.id),
      ['here'],
    );
  });

  it('breaks score ties by provider count then id for stable output', () => {
    const ranked = rankModels(
      [
        { ...build('z', 50), telemetry: { liveFree: 1 } },
        { ...build('a', 50), telemetry: { liveFree: 2 } },
      ],
      20,
    );
    assert.deepEqual(
      ranked.map((model) => model.id),
      ['a', 'z'],
    );
  });
});