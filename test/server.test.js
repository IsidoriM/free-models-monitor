import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createServer } from '../src/core/server.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const silentLogger = { warn() {}, error() {} };

/** Minimal monitor stand-in: the server only touches its store and status. */
class FakeMonitor extends EventEmitter {
  constructor() {
    super();
    this.store = {
      getState: () => ({ generatedAt: null, models: [], extras: [], failures: [], counts: { tracked: 0 } }),
      getModels: () => [],
      getExtras: () => [],
      getHistory: () => [],
      getFeed: () => [],
    };
  }

  getStatus() {
    return { running: false, cycles: 0, nextRunAt: null, pollIntervalMs: 60_000 };
  }
}

const scannerFor = (overrides = {}) => ({
  calls: [],
  cancelled: 0,
  isRunning: () => false,
  start() {
    this.calls.push('start');
    return { state: 'scanning' };
  },
  cancel() {
    this.cancelled += 1;
  },
  snapshot: () => ({ status: { state: 'idle', ...overrides }, result: null }),
  getStatus: () => ({ state: 'idle', ...overrides }),
  on() {},
});

async function withServer(run, trojans = null) {
  const { server } = createServer({
    monitor: new FakeMonitor(),
    trojans,
    config: { publicDir },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(async (route, init, { stream = false } = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, init);
      if (stream) {
        // An event stream never ends, so read the first frame and hang up.
        const reader = response.body.getReader();
        const { value } = await reader.read();
        await reader.cancel();
        return { response, body: Buffer.from(value ?? []).toString('utf8') };
      }
      return { response, body: await response.text() };
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('server static routes', () => {
  it('keeps the main dashboard on /', async () => {
    await withServer(async (call) => {
      const { response, body } = await call('/');
      assert.equal(response.status, 200);
      assert.match(body, /free models monitor/);
    });
  });

  it('serves the typologies dashboard at /typologies and /typologies/', async () => {
    await withServer(async (call) => {
      for (const route of ['/typologies', '/typologies/']) {
        const { response, body } = await call(route);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/html/);
        assert.match(body, /typolog/i);
      }

      const script = await call('/typologies.js');
      assert.equal(script.response.status, 200);
      assert.match(script.response.headers.get('content-type'), /javascript/);

      const css = await call('/typologies.css');
      assert.equal(css.response.status, 200);
      assert.match(css.response.headers.get('content-type'), /text\/css/);
    });
  });

  it('serves the origins dashboard at /origins and /origins/', async () => {
    await withServer(async (call) => {
      for (const route of ['/origins', '/origins/']) {
        const { response, body } = await call(route);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/html/);
        assert.match(body, /model origins/i);
      }

      const script = await call('/origins.js');
      assert.equal(script.response.status, 200);
      assert.match(script.response.headers.get('content-type'), /javascript/);

      const report = await call('/origins-report.js');
      assert.equal(report.response.status, 200);

      const css = await call('/origins.css');
      assert.equal(css.response.status, 200);
      assert.match(css.response.headers.get('content-type'), /text\/css/);
    });
  });

  it('links every section from the menu of every page', async () => {
    await withServer(async (call) => {
      for (const route of ['/', '/typologies', '/origins']) {
        const { body } = await call(route);
        assert.match(body, /href="\/typologies"/, `${route} is missing the typologies section`);
        assert.match(body, /href="\/origins"/, `${route} is missing the origins section`);
      }
    });
  });

  it('never serves a file from outside the public dir', async () => {
    await withServer(async (call) => {
      // Encoded and literal traversals: the guard may answer 403 or a plain 404,
      // what matters is that no file above public/ is ever served.
      for (const route of ['/..%2fpackage.json', '/%2e%2e/package.json', '/sub/../../package.json', '/../package.json']) {
        const { response, body } = await call(route);
        assert.notEqual(response.status, 200, `${route} must not be served`);
        assert.doesNotMatch(body, /free-models-monitor/, `${route} leaked a file outside public/`);
      }
    });
  });
});

describe('server trojan routes', () => {
  it('serves the current trojan snapshot', async () => {
    const trojans = scannerFor({ state: 'done' });
    await withServer(async (call) => {
      const { response, body } = await call('/api/trojans');
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(body).status.state, 'done');
    }, trojans);
  });

  it('starts a scan on POST and rejects anything else', async () => {
    const trojans = scannerFor();
    await withServer(async (call) => {
      const started = await call('/api/trojans/scan', { method: 'POST' });
      assert.equal(started.response.status, 202);
      assert.equal(JSON.parse(started.body).started, true);
      assert.deepEqual(trojans.calls, ['start']);

      const wrongMethod = await call('/api/trojans/scan');
      assert.equal(wrongMethod.response.status, 405);
    }, trojans);
  });

  it('cancels a running scan on POST', async () => {
    const trojans = scannerFor();
    await withServer(async (call) => {
      const cancelled = await call('/api/trojans/cancel', { method: 'POST' });
      assert.equal(cancelled.response.status, 200);
      assert.equal(trojans.cancelled, 1);

      const wrongMethod = await call('/api/trojans/cancel');
      assert.equal(wrongMethod.response.status, 405);
    }, trojans);
  });

  it('reports 503 on every trojan route when the scanner is disabled', async () => {
    await withServer(async (call) => {
      for (const route of ['/api/trojans', '/api/trojans/scan', '/api/trojans/cancel']) {
        const { response } = await call(route, { method: 'POST' });
        assert.equal(response.status, 503);
      }
    });
  });

  it('opens the event stream with the current trojan snapshot', async () => {
    const trojans = scannerFor({ state: 'idle' });
    await withServer(async (call) => {
      const { response, body } = await call('/api/events', undefined, { stream: true });
      assert.equal(response.status, 200);
      assert.match(body, /event: trojans/);
    }, trojans);
  });
});
