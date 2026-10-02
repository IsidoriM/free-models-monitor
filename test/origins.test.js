import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  countriesCsvOf,
  countriesOf,
  countryChart,
  defaultDirection,
  jsonOf,
  modelsCsvOf,
  originOfFamily,
  originOfModel,
  producerChart,
  producersOf,
  summarize,
  UNKNOWN_ORIGIN,
  visibleCountries,
} from '../public/origins-report.js';

const model = (id, extra = {}) => ({
  id,
  name: id,
  providerFamily: String(id).split('/')[0],
  score: 50,
  status: 'live',
  rank: 1,
  contextLength: 128_000,
  url: `https://openrouter.ai/${id}`,
  telemetry: { liveFree: 1 },
  ...extra,
});

const SNAPSHOT = [
  model('nvidia/nemotron-3-nano:free', { score: 90, rank: 1 }),
  model('nvidia/nemotron-3-super:free', { score: 70, rank: 2 }),
  model('google/gemma-4-31b-it:free', { score: 60, rank: 3 }),
  model('qwen/qwen3.8-27b:free', { score: 40, rank: 4, status: 'unavailable' }),
  model('cohere/north-mini-code:free', { score: 30, rank: 5 }),
  model('stealth/space-bunny-alpha', { score: 20, rank: 6 }),
];

describe('producer origins lookup', () => {
  it('maps a family slug to its producing nation', () => {
    assert.equal(originOfFamily('nvidia').country, 'United States');
    assert.equal(originOfFamily('nvidia').iso, 'US');
    assert.equal(originOfFamily('qwen').country, 'China');
    assert.equal(originOfFamily('cohere').country, 'Canada');
    assert.equal(originOfFamily('mistralai').country, 'France');
  });

  it('is case and whitespace insensitive, and follows aliases', () => {
    assert.equal(originOfFamily('  NVIDIA ').iso, 'US');
    assert.equal(originOfFamily('meta-llama').org, 'Meta');
    assert.equal(originOfFamily('z-ai/glm-4.6').country, 'China');
    // Unknown sub-brand still lands on the parent lab through the longest prefix.
    assert.equal(originOfFamily('thinkingmachines-lab/inkling').org, 'Thinking Machines Lab');
  });

  it('never guesses: unknown families fall into the explicit Unknown bucket', () => {
    for (const family of ['stealth', 'apodex', 'dots-studio', '', null, undefined]) {
      assert.equal(originOfFamily(family), UNKNOWN_ORIGIN, `${family} must not be guessed`);
    }
  });

  it('reads the family from the model, or from the id when it is missing', () => {
    assert.equal(originOfModel({ providerFamily: 'Poolside', id: 'x' }).country, 'United States');
    assert.equal(originOfModel({ id: 'mistralai/mistral-small-3:free' }).country, 'France');
    assert.equal(originOfModel({ id: 'who/what:free' }).country, 'Unknown');
  });
});

describe('countries of the tracked models', () => {
  it('groups models per nation, biggest first, with shares over the whole set', () => {
    const rows = countriesOf(SNAPSHOT);
    assert.deepEqual(
      rows.map((row) => [row.country, row.count]),
      [
        ['United States', 3],
        ['Canada', 1],
        ['China', 1],
        ['Unknown', 1],
      ],
    );
    const us = rows[0];
    assert.equal(us.iso, 'US');
    assert.equal(us.mapped, true);
    assert.equal(us.live, 3);
    assert.equal(us.share, 0.5);
    assert.equal(us.avgScore, 73.33333333333333);
    assert.deepEqual(
      us.producers.map((producer) => [producer.family, producer.org, producer.count]),
      [
        ['nvidia', 'NVIDIA', 2],
        ['google', 'Google DeepMind', 1],
      ],
    );
    assert.equal(us.top.id, 'nvidia/nemotron-3-nano:free');
  });

  it('marks the unmapped bucket so the gap stays visible', () => {
    const rows = countriesOf(SNAPSHOT);
    const unknown = rows.find((row) => row.country === 'Unknown');
    assert.equal(unknown.mapped, false);
    assert.equal(unknown.iso, '--');
    assert.deepEqual(
      unknown.producers.map((producer) => producer.family),
      ['stealth'],
    );
  });

  it('counts only live models for the live column', () => {
    const china = countriesOf(SNAPSHOT).find((row) => row.country === 'China');
    assert.equal(china.count, 1);
    assert.equal(china.live, 0);
  });

  it('survives an empty or broken payload', () => {
    assert.deepEqual(countriesOf([]), []);
    assert.deepEqual(countriesOf(null), []);
    assert.deepEqual(countriesOf([{ name: 'no id' }, null]), []);
    const summary = summarize([]);
    assert.equal(summary.models, 0);
    assert.equal(summary.countries, 0);
    assert.equal(summary.leader, null);
  });

  it('flattens every producer for the side chart', () => {
    assert.deepEqual(
      producersOf(countriesOf(SNAPSHOT)).map((producer) => [producer.org, producer.count]),
      [
        ['NVIDIA', 2],
        ['Alibaba Cloud', 1],
        ['Cohere', 1],
        ['Google DeepMind', 1],
        ['Unmapped producer', 1],
      ],
    );
  });
});

describe('summarize', () => {
  it('reports the headline numbers of the page', () => {
    const summary = summarize(SNAPSHOT);
    assert.equal(summary.models, 6);
    assert.equal(summary.countries, 3);
    assert.equal(summary.producers, 4);
    assert.equal(summary.live, 5);
    assert.equal(summary.unmappedModels, 1);
    assert.equal(summary.unmappedProducers, 1);
    assert.equal(summary.leader.country, 'United States');
  });
});

describe('country filters and sorting', () => {
  const rows = countriesOf(SNAPSHOT);

  it('sorts numbers descending and text ascending by default', () => {
    assert.equal(defaultDirection('models'), -1);
    assert.equal(defaultDirection('score'), -1);
    assert.equal(defaultDirection('country'), 1);
    assert.deepEqual(
      visibleCountries(rows, { sortKey: 'country' }).map((row) => row.country),
      ['Canada', 'China', 'United States', 'Unknown'],
    );
    assert.deepEqual(
      visibleCountries(rows, { sortKey: 'live' }).map((row) => row.country),
      ['United States', 'Canada', 'Unknown', 'China'],
    );
  });

  it('filters by country, iso code, lab and model id', () => {
    assert.deepEqual(visibleCountries(rows, { query: 'canada' }).map((row) => row.iso), ['CA']);
    assert.deepEqual(visibleCountries(rows, { query: 'cn' }).map((row) => row.iso), ['CN']);
    assert.deepEqual(visibleCountries(rows, { query: 'nvidia' }).map((row) => row.iso), ['US']);
    assert.deepEqual(visibleCountries(rows, { query: 'nemotron' }).map((row) => row.iso), ['US']);
    assert.deepEqual(visibleCountries(rows, { query: 'nothing here' }), []);
  });

  it('can hide the nations without a live free model', () => {
    const visible = visibleCountries(rows, { onlyLive: true });
    assert.equal(visible.find((row) => row.country === 'China'), undefined);
    assert.equal(visible.length, 3);
  });

  it('never mutates the rows it was given', () => {
    const before = rows.map((row) => row.country);
    visibleCountries(rows, { query: 'united', sortKey: 'country', sortDir: 1 });
    assert.deepEqual(rows.map((row) => row.country), before);
  });
});

describe('charts and exports', () => {
  const rows = countriesOf(SNAPSHOT);

  it('renders a bar per nation and per producer', () => {
    const countries = countryChart(rows);
    assert.match(countries, /United States/);
    assert.match(countries, /class="barfill"/);
    assert.match(producerChart(rows), /NVIDIA/);
  });

  it('renders an empty state instead of an empty chart', () => {
    assert.match(countryChart([]), /class="empty"/);
    assert.match(producerChart([]), /class="empty"/);
  });

  it('exports one row per nation, and one per model', () => {
    const nations = countriesCsvOf(rows).trim().split('\n');
    assert.equal(nations[0], 'iso,country,models,share,live,avg_score,producers,producer_families,top_model');
    assert.equal(nations.length, 5);
    assert.match(nations[1], /^US,United States,3,0\.5000,3,/);

    const models = modelsCsvOf(rows).trim().split('\n');
    assert.equal(models[0], 'model_id,name,family,producer,country,iso,rank,score,status,free_providers,context_length');
    assert.equal(models.length, 7);
    assert.match(models[1], /^nvidia\/nemotron-3-nano:free,/);
  });

  it('escapes a cell that carries a comma', () => {
    const csv = modelsCsvOf(countriesOf([model('meta-llama/llama-4-scout:free', { name: 'Meta, free edition' })])).trim().split('\n');
    assert.match(csv[1], /"Meta, free edition"/);
  });

  it('exports json with the same rows the table shows', () => {
    const parsed = JSON.parse(jsonOf(visibleCountries(rows, { query: 'canada' }), { generatedAt: '2026-01-02T03:04:05.000Z' }));
    assert.equal(parsed.generatedAt, '2026-01-02T03:04:05.000Z');
    assert.equal(parsed.countries.length, 1);
    assert.deepEqual(parsed.countries[0].modelIds, ['cohere/north-mini-code:free']);
    assert.equal(parsed.countries[0].producers[0].org, 'Cohere');
  });
});
