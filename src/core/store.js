import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Holds the ranked board, per-model history and derived change events.
 * Emits `snapshot` (full board) and `changes` (what moved since last cycle).
 */
export class Store extends EventEmitter {
  #history = new Map();
  #previousRanks = new Map();
  #previousScores = new Map();
  #firstSeen = new Map();
  #latest = null;
  #feed = [];
  #cycles = 0;

  constructor(config) {
    super();
    this.config = config;
  }

  get cycles() {
    return this.#cycles;
  }

  /** Replaces the board, computes rank deltas and records a history sample. */
  applySnapshot({ ranked, extras = [], catalog = {}, failures = [], durationMs = 0, cycle = 0 }) {
    const timestamp = Date.now();
    this.#cycles += 1;

    const changes = [];
    const seen = new Set();

    // Rank is authoritative here, so sort defensively rather than trusting input order.
    const ordered = [...ranked].sort(
      (a, b) => b.score - a.score || (b.telemetry?.liveFree ?? 0) - (a.telemetry?.liveFree ?? 0) || a.id.localeCompare(b.id),
    );

    ordered.forEach((model, index) => {
      seen.add(model.id);
      const rank = index + 1;
      const previousRank = this.#previousRanks.get(model.id) ?? null;
      const previousScore = this.#previousScores.get(model.id) ?? null;
      const rankDelta = previousRank === null ? null : previousRank - rank;
      const scoreDelta = previousScore === null ? null : Math.round((model.score - previousScore) * 10) / 10;

      if (rankDelta === null) {
        changes.push({ type: 'entered', modelId: model.id, modelName: model.name, rank, at: timestamp });
      } else if (rankDelta !== 0) {
        changes.push({
          type: rankDelta > 0 ? 'rank-up' : 'rank-down',
          modelId: model.id,
          modelName: model.name,
          from: previousRank,
          to: rank,
          delta: rankDelta,
          at: timestamp,
        });
      }

      const previousStatus = this.#previousScores.get(`status:${model.id}`);
      if (previousStatus !== undefined && previousStatus !== model.status) {
        changes.push({
          type: 'status',
          modelId: model.id,
          modelName: model.name,
          from: previousStatus,
          to: model.status,
          at: timestamp,
        });
      }
      this.#previousScores.set(`status:${model.id}`, model.status);

      this.#firstSeen.set(model.id, this.#firstSeen.get(model.id) ?? timestamp);
      this.#previousRanks.set(model.id, rank);
      this.#previousScores.set(model.id, model.score);

      this.#pushHistory(model.id, {
        t: timestamp,
        score: model.score,
        uptime: model.telemetry.bestUptime5m,
        latency: model.telemetry.bestLatencyMs,
        live: model.telemetry.liveFree,
      });

      model.rank = rank;
      model.rankDelta = rankDelta;
      model.scoreDelta = scoreDelta;
      model.firstSeenAt = new Date(this.#firstSeen.get(model.id)).toISOString();
      model.samples = this.#history.get(model.id)?.length ?? 0;
    });

    for (const [id, rank] of this.#previousRanks) {
      if (!seen.has(id)) {
        changes.push({ type: 'dropped', modelId: id, from: rank, at: timestamp });
        this.#previousRanks.delete(id);
        this.#previousScores.delete(id);
        this.#previousScores.delete(`status:${id}`);
      }
    }

    const snapshot = {
      generatedAt: new Date(timestamp).toISOString(),
      cycle,
      durationMs,
      topN: ordered.length,
      catalog,
      failures,
      models: ordered,
      extras,
      counts: {
        tracked: ordered.length,
        free: catalog.freeModels ?? null,
        catalogTotal: catalog.totalModels ?? null,
        live: ordered.filter((model) => model.status === 'live').length,
        unavailable: ordered.filter((model) => model.status === 'unavailable').length,
        expiringSoon: ordered.filter((model) => model.expiry?.state === 'expiring').length,
      },
    };

    this.#latest = snapshot;
    for (const change of changes) this.#pushFeed(change);

    this.emit('snapshot', snapshot);
    if (changes.length) this.emit('changes', changes);
    return snapshot;
  }

  getState() {
    return (
      this.#latest ?? {
        generatedAt: null,
        cycle: 0,
        models: [],
        extras: [],
        failures: [],
        counts: { tracked: 0, live: 0, unavailable: 0, expiringSoon: 0 },
      }
    );
  }

  getModels() {
    return this.getState().models;
  }

  getExtras() {
    return this.getState().extras ?? [];
  }

  getFailures() {
    return this.getState().failures ?? [];
  }

  getHistory(id, limit = this.config.historySize) {
    const samples = this.#history.get(id) ?? [];
    return samples.slice(-limit);
  }

  getAllHistory() {
    const result = {};
    for (const [id, samples] of this.#history) result[id] = samples;
    return result;
  }

  getFeed(limit = 40) {
    return this.#feed.slice(-limit).reverse();
  }

  #pushHistory(id, sample) {
    const samples = this.#history.get(id) ?? [];
    samples.push(sample);
    if (samples.length > this.config.historySize) samples.splice(0, samples.length - this.config.historySize);
    this.#history.set(id, samples);
  }

  #pushFeed(change) {
    this.#feed.push(change);
    if (this.#feed.length > 200) this.#feed.splice(0, this.#feed.length - 200);
  }

  async #writeJsonAtomic(filePath, value) {
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, filePath);
  }

  async persist() {
    if (!this.config.persist) return;
    try {
      await mkdir(this.config.dataDir, { recursive: true });
      const state = this.getState();
      await this.#writeJsonAtomic(path.join(this.config.dataDir, 'latest.json'), {
        ...state,
        history: undefined,
        feed: this.getFeed(40),
      });
      await this.#writeJsonAtomic(path.join(this.config.dataDir, 'history.json'), this.getAllHistory());
    } catch (error) {
      this.emit('warn', `persist failed: ${error.message}`);
    }
  }

  /** Restores the last persisted board so restarts keep rank continuity. */
  async restore() {
    if (!this.config.persist) return false;
    try {
      const raw = await readFile(path.join(this.config.dataDir, 'latest.json'), 'utf8');
      const parsed = JSON.parse(raw);
      for (const model of parsed.models ?? []) {
        if (typeof model.rank === 'number') this.#previousRanks.set(model.id, model.rank);
        if (typeof model.score === 'number') this.#previousScores.set(model.id, model.score);
        if (model.status) this.#previousScores.set(`status:${model.id}`, model.status);
        if (model.firstSeenAt) this.#firstSeen.set(model.id, Date.parse(model.firstSeenAt));
      }
      const history = JSON.parse(await readFile(path.join(this.config.dataDir, 'history.json'), 'utf8'));
      for (const [id, samples] of Object.entries(history ?? {})) this.#history.set(id, samples);
      return true;
    } catch {
      return false;
    }
  }
}