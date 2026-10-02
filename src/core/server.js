import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { config as defaultConfig } from '../config.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const HEARTBEAT_MS = 20_000;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function serveStatic(res, publicDir, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.resolve(publicDir, relative);
  if (!target.startsWith(path.resolve(publicDir))) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-cache',
    });
    createReadStream(target).pipe(res);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

export function createServer({ monitor, config = defaultConfig, trojans = null, typologies = null }) {
  const clients = new Set();

  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      if (!res.writableEnded) res.write(frame);
    }
  };

  monitor.on('snapshot', (snapshot) => {
    broadcast('snapshot', {
      ...snapshot,
      status: monitor.getStatus(),
      history: undefined,
    });
  });
  monitor.on('changes', (changes) => broadcast('changes', { changes }));
  monitor.on('error', (error) => broadcast('error', { message: error.message }));
  trojans?.on('update', (payload) => broadcast('trojans', payload));
  typologies?.on('update', (payload) => broadcast('typologies', payload));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const route = url.pathname;

    try {
      if (route === '/api/state') {
        const state = monitor.store.getState();
        return sendJson(res, 200, {
          ...state,
          history: undefined,
          status: monitor.getStatus(),
          feed: monitor.store.getFeed(40),
          extras: monitor.store.getExtras(),
        });
      }

      if (route === '/api/models') {
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
        const models = monitor.store.getModels();
        return sendJson(res, 200, {
          count: models.length,
          models: Number.isFinite(limit) && limit > 0 ? models.slice(0, limit) : models,
        });
      }

      if (route === '/api/history') {
        const id = url.searchParams.get('id');
        if (!id) return sendJson(res, 400, { error: 'missing id' });
        const samples = monitor.store.getHistory(id);
        if (!samples.length) return sendJson(res, 404, { error: 'unknown model' });
        return sendJson(res, 200, { id, count: samples.length, samples });
      }

      if (route === '/api/status') {
        return sendJson(res, 200, {
          ...monitor.getStatus(),
          clients: clients.size,
          tracked: monitor.store.getModels().length,
        });
      }

      if (route === '/api/feed') {
        return sendJson(res, 200, { feed: monitor.store.getFeed(60) });
      }

      if (route === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write('retry: 5000\n\n');
        const snapshot = monitor.store.getState();
        res.write(`event: snapshot\ndata: ${JSON.stringify({ ...snapshot, status: monitor.getStatus() })}\n\n`);
        if (trojans) {
          res.write(`event: trojans\ndata: ${JSON.stringify(trojans.snapshot())}\n\n`);
        }
        if (typologies) {
          res.write(`event: typologies\ndata: ${JSON.stringify(typologies.snapshot())}\n\n`);
        }
        clients.add(res);
        const heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(`: ping ${Date.now()}\n\n`);
        }, HEARTBEAT_MS);
        heartbeat.unref?.();
        req.on('close', () => {
          clearInterval(heartbeat);
          clients.delete(res);
        });
        return undefined;
      }

      if (route === '/api/trojans/scan') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'use POST' });
        if (!trojans) return sendJson(res, 503, { error: 'trojan scanner disabled' });
        req.resume();
        try {
          return sendJson(res, 202, { started: true, status: trojans.start() });
        } catch (error) {
          return sendJson(res, 409, { error: error.message });
        }
      }

      if (route === '/api/trojans/cancel') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'use POST' });
        if (!trojans) return sendJson(res, 503, { error: 'trojan scanner disabled' });
        req.resume();
        const running = trojans.isRunning();
        trojans.cancel();
        return sendJson(res, 200, { cancelled: running, status: trojans.getStatus() });
      }

      if (route === '/api/trojans') {
        if (!trojans) return sendJson(res, 503, { error: 'trojan scanner disabled' });
        return sendJson(res, 200, trojans.snapshot());
      }

      if (route === '/api/typologies/scan') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'use POST' });
        if (!typologies) return sendJson(res, 503, { error: 'typology scanner disabled' });
        req.resume();
        try {
          return sendJson(res, 202, { started: true, status: typologies.start() });
        } catch (error) {
          return sendJson(res, 409, { error: error.message });
        }
      }

      if (route === '/api/typologies/cancel') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'use POST' });
        if (!typologies) return sendJson(res, 503, { error: 'typology scanner disabled' });
        req.resume();
        const running = typologies.isRunning();
        typologies.cancel();
        return sendJson(res, 200, { cancelled: running, status: typologies.getStatus() });
      }

      if (route === '/api/typologies') {
        if (!typologies) return sendJson(res, 503, { error: 'typology scanner disabled' });
        return sendJson(res, 200, typologies.snapshot());
      }

      if (route.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown endpoint' });

      // The file typologies census gets its own page so it can own the full width.
      if (route === '/typologies' || route === '/typologies/') {
        return await serveStatic(res, config.publicDir, '/typologies.html');
      }

      // Same for the nations of the model producers: its own page, its own report.
      if (route === '/origins' || route === '/origins/') {
        return await serveStatic(res, config.publicDir, '/origins.html');
      }

      return await serveStatic(res, config.publicDir, route);
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  });

  server.on('clientError', (_error, socket) => socket.destroy());

  return { server, clients };
}