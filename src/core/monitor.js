import { EventEmitter } from 'node:events';
import { normalizeModel, rankModels } from './normalize.js';
import { Prober } from './prober.js';
import { Store } from './store.js';

/**
 * Drives the polling loop: fetch free catalog + provider telemetry, score and
 * rank it, hand the board to the Store, and emit the result.
 */
export class Monitor extends EventEmitter {
  constructor({ source, config, logger = console }) {
    super();
    this.source = source;
    this.config = config;
    this.logger = logger;
    this.store = new Store(config);
    this.prober = new Prober({ source, config, logger });
    this.timer = null;
    this.running = false;
    this.lastError = null;
    this.lastRunAt = null;
    this.nextRunAt = null;
  }

  async start() {
    await this.store.restore();
    for (const event of ['snapshot', 'changes']) {
      this.store.on(event, (payload) => this.emit(event, payload));
    }
    this.store.on('warn', (message) => this.logger.warn?.(message));
    await this.cycle();
    this.timer = setInterval(() => {
      this.cycle().catch((error) => {
        this.lastError = { message: error.message, at: new Date().toISOString() };
        this.logger.error?.(`poll failed: ${error.message}`);
        this.emit('error', error);
      });
    }, this.config.pollIntervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async cycle() {
    if (this.running) return this.store.getState();
    this.running = true;
    const startedAt = Date.now();
    this.nextRunAt = startedAt + this.config.pollIntervalMs;
    try {
      const collected = await this.source.collectFreeModels();
      const now = Date.now();
      const normalized = collected.models.map(({ raw, endpoints }) =>
        normalizeModel(raw, { endpoints, now }),
      );

      const ranked = rankModels(normalized, this.config.topN);
      const extras = normalized
        .filter((model) => !ranked.some((top) => top.id === model.id))
        .sort((a, b) => b.score - a.score)
        .slice(0, 25);

      const probes = await this.prober.run(ranked);
      if (probes) {
        for (const model of ranked) {
          if (probes[model.id]) model.probe = probes[model.id];
        }
      }

      this.lastError = null;
      this.lastRunAt = new Date(now).toISOString();

      const snapshot = this.store.applySnapshot({
        ranked,
        extras,
        catalog: collected.catalog,
        failures: collected.failures,
        durationMs: Date.now() - startedAt,
        cycle: this.store.cycles + 1,
      });
      await this.store.persist();
      this.emit('cycle', snapshot);
      return snapshot;
    } finally {
      this.running = false;
    }
  }

  getStatus() {
    return {
      running: this.running,
      cycles: this.store.cycles,
      lastRunAt: this.lastRunAt,
      nextRunAt: this.nextRunAt ? new Date(this.nextRunAt).toISOString() : null,
      pollIntervalMs: this.config.pollIntervalMs,
      lastError: this.lastError,
      probeEnabled: this.prober.enabled,
      probes: this.prober.results,
    };
  }
}