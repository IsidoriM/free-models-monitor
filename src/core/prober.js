/**
 * Optional live inference probe. Disabled unless PROBE_ENABLED=true and
 * OPENROUTER_API_KEY is set, and throttled so it cannot burn the free-tier
 * rate limit: at most `topN` models every `everyCycles` polls.
 */
export class Prober {
  #cycleCount = 0;
  #results = new Map();

  constructor({ source, config, logger = console }) {
    this.source = source;
    this.config = config.probe;
    this.logger = logger;
  }

  get enabled() {
    return this.config.enabled;
  }

  get results() {
    return Object.fromEntries(this.#results);
  }

  /**
   * @returns {Promise<null|object>} probe results keyed by model id, or null
   * when probing is off or not due this cycle.
   */
  async run(models) {
    this.#cycleCount += 1;
    if (!this.config.enabled) return null;
    if (this.#cycleCount % this.config.everyCycles !== 1) return null;

    const targets = models.filter((model) => model.status === 'live').slice(0, this.config.topN);
    for (const model of targets) {
      const startedAt = Date.now();
      try {
        const result = await this.source.probeCompletion({
          model: model.id,
          prompt: 'Reply with the single word: ok',
          maxTokens: this.config.maxTokens,
        });
        this.#results.set(model.id, {
          ok: result.ok,
          latencyMs: Date.now() - startedAt,
          sample: result.sample,
          at: new Date().toISOString(),
        });
      } catch (error) {
        this.#results.set(model.id, {
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: error.message,
          at: new Date().toISOString(),
        });
      }
    }
    return this.results;
  }
}