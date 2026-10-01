import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapLimit } from '../src/core/http.js';
import { Store } from '../src/core/store.js';

const testConfig = { historySize: 5, persist: false, dataDir: 'unused' };

const model = (id, score, extra = {}) => ({
  id,
  name: id,
  score,
  rank: 1,
  status: 'live',
  expiry: { state: 'none', daysLeft: null },
  telemetry: { bestUptime5m: 99, bestUptime1d: 98, bestLatencyMs: 500, liveFree: 1, freeProviders: ['p'], free: 1, total: 1 },
  ...extra,
});

const snapshotOf = (...models) => ({
  ranked: models,
  catalog: { totalModels: 100, freeModels: 20 },
  failures: [],
  durationMs: 10,
  cycle: 1,
});

describe('Store', () => {
  it('assigns ranks and reports them as new entries on first snapshot', () => {
    const store = new Store(testConfig);
    const changes = [];
    store.on('changes', (payload) => changes.push(...payload));
    store.applySnapshot(snapshotOf(model('a', 50), model('b', 90)));

    assert.deepEqual(
      store.getModels().map((m) => [m.id, m.rank]),
      [
        ['b', 1],
        ['a', 2],
      ],
    );
    assert.equal(changes.filter((change) => change.type === 'entered').length, 2);
  });

  it('emits rank-up and rank-down deltas when the order flips', () => {
    const store = new Store(testConfig);
    store.applySnapshot(snapshotOf(model('a', 50), model('b', 90)));
    const changes = [];
    store.on('changes', (payload) => changes.push(...payload));
    store.applySnapshot(snapshotOf(model('a', 95), model('b', 10)));

    const up = changes.find((change) => change.type === 'rank-up');
    assert.equal(up.modelId, 'a');
    assert.equal(up.delta, 1);
    assert.equal(store.getModels().find((m) => m.id === 'a').rankDelta, 1);
  });

  it('emits status transitions', () => {
    const store = new Store(testConfig);
    store.applySnapshot(snapshotOf(model('a', 50)));
    const changes = [];
    store.on('changes', (payload) => changes.push(...payload));
    store.applySnapshot(snapshotOf(model('a', 50, { status: 'unavailable' })));

    assert.equal(changes.find((change) => change.type === 'status')?.to, 'unavailable');
  });

  it('emits dropped for models that leave the board', () => {
    const store = new Store(testConfig);
    store.applySnapshot(snapshotOf(model('a', 50), model('b', 40)));
    const changes = [];
    store.on('changes', (payload) => changes.push(...payload));
    store.applySnapshot(snapshotOf(model('b', 40)));

    assert.equal(changes.find((change) => change.type === 'dropped')?.modelId, 'a');
  });

  it('caps history at the configured size', () => {
    const store = new Store({ ...testConfig, historySize: 3 });
    for (let i = 0; i < 6; i += 1) {
      store.applySnapshot(snapshotOf(model('a', 50 + i)));
    }
    const history = store.getHistory('a');
    assert.equal(history.length, 3);
    assert.equal(history.at(-1).score, 55);
  });

  it('exposes the change feed newest first', () => {
    const store = new Store(testConfig);
    store.applySnapshot(snapshotOf(model('a', 10)));
    store.applySnapshot(snapshotOf(model('b', 99)));
    const feed = store.getFeed();
    assert.equal(feed[0].at >= feed.at(-1).at, true);
  });

  it('summarises counts in the snapshot', () => {
    const store = new Store(testConfig);
    const snapshot = store.applySnapshot(
      snapshotOf(model('a', 50), model('b', 40, { status: 'unavailable' }), model('c', 30, { expiry: { state: 'expiring', daysLeft: 3 } })),
    );
    assert.equal(snapshot.counts.tracked, 3);
    assert.equal(snapshot.counts.live, 2);
    assert.equal(snapshot.counts.unavailable, 1);
    assert.equal(snapshot.counts.expiringSoon, 1);
    assert.equal(snapshot.counts.free, 20);
  });
});

describe('mapLimit', () => {
  it('preserves order and never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return value * 2;
    });
    assert.deepEqual(results.map((r) => r.value), [2, 4, 6, 8, 10, 12, 14, 16]);
    assert.ok(peak <= 3, `peak concurrency was ${peak}`);
  });

  it('captures per-item failures without rejecting', async () => {
    const results = await mapLimit([1, 2, 3], 2, async (value) => {
      if (value === 2) throw new Error('boom');
      return value;
    });
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, false);
    assert.equal(results[1].error.message, 'boom');
    assert.equal(results[2].ok, true);
  });
});