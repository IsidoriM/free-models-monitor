/**
 * Pure reporting layer for the ModelOrigins page.
 *
 * OpenRouter publishes no country, organization or vendor field: the family
 * slug (the `owner` half of `owner/model`, already parsed by the normalizer into
 * `providerFamily`) is the only provenance signal the catalog carries. So the
 * nation of a model is resolved here against a curated table of labs, and
 * anything it does not know lands in an explicit `Unknown` bucket instead of
 * being guessed.
 *
 * Everything below works on the snapshot payload and stays DOM-free, so the
 * browser module and the tests can share it.
 */

import { escapeHtml, fmt } from './format.js';

export { escapeHtml, fmt };

export const TABLE_LIMIT = 40;

export const UNKNOWN_ORIGIN = Object.freeze({
  iso: '--',
  country: 'Unknown',
  org: 'Unmapped producer',
  family: '',
});

/**
 * Producer family -> producing organization -> country of the headquarters.
 * `aliases` covers the other slugs an org publishes under; a family that starts
 * with a known alias is matched too, so `meta-llama` style sub-brands land on
 * their parent without a second entry.
 */
export const PRODUCER_ORIGINS = Object.freeze([
  { family: 'ai21labs', org: 'AI21 Labs', country: 'Israel', iso: 'IL', aliases: ['ai21', 'jamba'] },
  { family: 'alibaba', org: 'Alibaba Cloud', country: 'China', iso: 'CN', aliases: ['aliyun', 'tongyi'] },
  { family: 'allenai', org: 'Alibaba DAMO Academy', country: 'China', iso: 'CN', aliases: ['nlp'] },
  { family: 'amazon', org: 'Amazon', country: 'United States', iso: 'US', aliases: ['nova'] },
  { family: 'anthropic', org: 'Anthropic', country: 'United States', iso: 'US', aliases: ['claude'] },
  { family: 'baidu', org: 'Baidu', country: 'China', iso: 'CN', aliases: ['ernie'] },
  { family: 'black-forest-labs', org: 'Black Forest Labs', country: 'Germany', iso: 'DE', aliases: ['bfl', 'flux'] },
  { family: 'bytedance', org: 'ByteDance', country: 'China', iso: 'CN', aliases: ['doubao', 'seed'] },
  { family: 'cohere', org: 'Cohere', country: 'Canada', iso: 'CA', aliases: ['command-r', 'aya'] },
  { family: 'deepseek', org: 'DeepSeek', country: 'China', iso: 'CN', aliases: ['deepseek-ai'] },
  { family: 'google', org: 'Google DeepMind', country: 'United States', iso: 'US', aliases: ['gemma', 'google-deepmind'] },
  { family: 'ibm-granite', org: 'IBM', country: 'United States', iso: 'US', aliases: ['ibm', 'granite'] },
  { family: 'inclusionai', org: 'Ant Group / inclusionAI', country: 'China', iso: 'CN', aliases: ['ling', 'ant'] },
  { family: 'internlm', org: 'Shanghai AI Laboratory', country: 'China', iso: 'CN', aliases: ['internlm2'] },
  { family: 'kakao', org: 'Kakao Brain', country: 'South Korea', iso: 'KR', aliases: ['kanana'] },
  { family: 'liquid', org: 'Liquid AI', country: 'United States', iso: 'US', aliases: ['liquidai', 'lfm'] },
  { family: 'meta-llama', org: 'Meta', country: 'United States', iso: 'US', aliases: ['meta', 'llama', 'llama-4'] },
  { family: 'microsoft', org: 'Microsoft', country: 'United States', iso: 'US', aliases: ['phi'] },
  { family: 'minimax', org: 'MiniMax', country: 'China', iso: 'CN', aliases: ['minimax-ai'] },
  { family: 'mistralai', org: 'Mistral AI', country: 'France', iso: 'FR', aliases: ['mistral'] },
  { family: 'moonshotai', org: 'Moonshot AI', country: 'China', iso: 'CN', aliases: ['moonshot', 'kimi'] },
  { family: 'naver', org: 'NAVER HyperCLOVA X', country: 'South Korea', iso: 'KR', aliases: ['hyperclova'] },
  { family: 'nscale', org: 'Nscale', country: 'United Kingdom', iso: 'GB', aliases: [] },
  { family: 'nousresearch', org: 'Nous Research', country: 'United States', iso: 'US', aliases: ['nous', 'hermes'] },
  { family: 'nvidia', org: 'NVIDIA', country: 'United States', iso: 'US', aliases: ['nemotron', 'nvidia-nemotron'] },
  { family: '01-ai', org: '01.AI', country: 'China', iso: 'CN', aliases: ['yi'] },
  { family: 'openai', org: 'OpenAI', country: 'United States', iso: 'US', aliases: ['openai-community'] },
  { family: 'openbmb', org: 'OpenBMB', country: 'China', iso: 'CN', aliases: [] },
  { family: 'openrouter', org: 'OpenRouter', country: 'United States', iso: 'US', aliases: [] },
  { family: 'perplexity', org: 'Perplexity AI', country: 'United States', iso: 'US', aliases: ['sonar'] },
  { family: 'poolside', org: 'Poolside', country: 'United States', iso: 'US', aliases: [] },
  { family: 'qwen', org: 'Alibaba Cloud', country: 'China', iso: 'CN', aliases: ['qwq'] },
  { family: 'sakanaai', org: 'Sakana AI', country: 'Japan', iso: 'JP', aliases: ['sakana', 'einstein'] },
  { family: 'stabilityai', org: 'Stability AI', country: 'United Kingdom', iso: 'GB', aliases: ['stability'] },
  { family: 'stepfun', org: 'StepFun', country: 'China', iso: 'CN', aliases: ['step'] },
  { family: 'tencent', org: 'Tencent', country: 'China', iso: 'CN', aliases: ['hunyuan'] },
  { family: 'thudm', org: 'Zhipu AI', country: 'China', iso: 'CN', aliases: ['z-ai', 'zhipu', 'glm'] },
  { family: 'thinkingmachines', org: 'Thinking Machines Lab', country: 'United States', iso: 'US', aliases: ['tml', 'inkling'] },
  { family: 'unsloth', org: 'Unsloth', country: 'United States', iso: 'US', aliases: [] },
  { family: 'upstage', org: 'Upstage', country: 'South Korea', iso: 'KR', aliases: ['solar'] },
  { family: 'writer', org: 'Writer', country: 'United States', iso: 'US', aliases: ['palmyra'] },
  { family: 'x-ai', org: 'xAI', country: 'United States', iso: 'US', aliases: ['grok'] },
]);

const INDEX = new Map();
for (const entry of PRODUCER_ORIGINS) {
  for (const key of [entry.family, ...(entry.aliases ?? [])]) {
    if (key) INDEX.set(key, entry);
  }
}

/** Longest keys first, so a specific brand wins over a shorter accidental prefix. */
const KEYS = [...INDEX.keys()].sort((a, b) => b.length - a.length);

const collator = new Intl.Collator(undefined, { numeric: true });

const isMapped = (origin) => origin !== UNKNOWN_ORIGIN;

const isLive = (model) => model?.status === 'live';

export const familyOf = (model) =>
  String(model?.providerFamily ?? String(model?.id ?? '').split('/')[0] ?? '')
    .trim()
    .toLowerCase();

/** Curated lookup: exact family, then exact alias, then longest alias prefix. */
export function originOfFamily(family) {
  const key = String(family ?? '').trim().toLowerCase();
  if (!key) return UNKNOWN_ORIGIN;
  const exact = INDEX.get(key);
  if (exact) return exact;
  const prefix = KEYS.find((candidate) => key.startsWith(candidate));
  return prefix ? INDEX.get(prefix) : UNKNOWN_ORIGIN;
}

/** The curated answer for one model, tagged with whether it is actually known. */
export function originOfModel(model) {
  const family = familyOf(model);
  const origin = originOfFamily(family);
  return {
    family,
    org: origin.org,
    country: origin.country,
    iso: origin.iso,
    mapped: isMapped(origin),
  };
}

/**
 * One row per nation, biggest first. Every row keeps its models so the detail
 * dialog can drill down without another round trip.
 */
export function countriesOf(models) {
  const list = Array.isArray(models) ? models.filter((model) => model && typeof model.id === 'string') : [];
  const buckets = new Map();

  for (const model of list) {
    const origin = originOfModel(model);
    const key = `${origin.country}|${origin.iso}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { iso: origin.iso, country: origin.country, mapped: origin.mapped, producers: new Map(), models: [] };
      buckets.set(key, bucket);
    }
    bucket.models.push(model);

    const family = origin.family || String(model.id).split('/')[0].toLowerCase();
    const producer = bucket.producers.get(family) ?? { family, org: origin.org, country: origin.country, count: 0 };
    producer.count += 1;
    bucket.producers.set(family, producer);
  }

  return [...buckets.values()]
    .map((bucket) => {
      const ordered = bucket.models
        .slice()
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || collator.compare(a.id, b.id));
      const scored = bucket.models.filter((model) => Number.isFinite(model.score));
      return {
        iso: bucket.iso,
        country: bucket.country,
        mapped: bucket.mapped,
        producers: [...bucket.producers.values()].sort(
          (a, b) => b.count - a.count || collator.compare(a.family, b.family),
        ),
        models: ordered,
        count: ordered.length,
        live: ordered.filter(isLive).length,
        share: ordered.length / (list.length || 1),
        avgScore: scored.length ? scored.reduce((sum, model) => sum + model.score, 0) / scored.length : null,
        top: ordered[0] ?? null,
      };
    })
    .sort((a, b) => b.count - a.count || collator.compare(a.country, b.country));
}

/** Every producer of every row, flat, so the side chart can rank them. */
export function producersOf(rows) {
  return (rows ?? [])
    .flatMap((row) => row.producers)
    .sort((a, b) => b.count - a.count || collator.compare(a.org, b.org));
}

export function summarize(models) {
  const rows = countriesOf(models);
  const unmapped = rows.find((row) => !row.mapped) ?? null;
  const mapped = rows.filter((row) => row.mapped);
  return {
    models: rows.reduce((sum, row) => sum + row.count, 0),
    countries: mapped.length,
    producers: producersOf(mapped).length,
    unmappedModels: unmapped?.count ?? 0,
    unmappedProducers: unmapped?.producers.length ?? 0,
    live: rows.reduce((sum, row) => sum + row.live, 0),
    leader: mapped[0] ?? null,
  };
}

export const SORT_KEYS = ['models', 'live', 'score', 'country'];

/** Sorts that read better A->Z, so their direction is never flipped. */
const TEXT_SORTS = new Set(['country']);

export function defaultDirection(key) {
  return TEXT_SORTS.has(key) ? 1 : -1;
}

export function compareCountries(a, b, key) {
  if (key === 'live') return a.live - b.live;
  if (key === 'score') return (a.avgScore ?? 0) - (b.avgScore ?? 0);
  if (key === 'country') return collator.compare(a.country, b.country);
  return a.count - b.count;
}

/** Filters and orders the country rows for the table; never mutates `rows`. */
export function visibleCountries(rows, { query = '', onlyLive = false, sortKey = 'models', sortDir = -1 } = {}) {
  const needle = query.trim().toLowerCase();
  const filtered = (rows ?? []).filter((row) => {
    if (onlyLive && row.live === 0) return false;
    if (!needle) return true;
    if (row.country.toLowerCase().includes(needle)) return true;
    if (row.iso.toLowerCase() === needle) return true;
    return (
      row.producers.some(
        (producer) => producer.family.includes(needle) || producer.org.toLowerCase().includes(needle),
      ) || row.models.some((model) => model.id.toLowerCase().includes(needle))
    );
  });

  const dir = TEXT_SORTS.has(sortKey) ? 1 : sortDir;
  return [...filtered].sort((a, b) => {
    const primary = compareCountries(a, b, sortKey) * dir;
    return primary || compareCountries(a, b, 'models') || collator.compare(a.country, b.country);
  });
}

function countChart(entries, empty) {
  if (!entries.length) return `<p class="empty">${escapeHtml(empty)}</p>`;
  const max = entries.reduce((best, entry) => Math.max(best, entry.count), 0) || 1;
  const total = entries.reduce((sum, entry) => sum + entry.count, 0) || 1;
  return `<ul class="bars cool">${entries
    .map(
      (entry) => `<li title="${escapeHtml(`${entry.label}: ${fmt.num(entry.count)} model(s)`)}">
        <span class="barlabel">${escapeHtml(entry.label)}</span>
        <span class="bartrack"><span class="barfill" style="width:${((entry.count / max) * 100).toFixed(2)}%"></span></span>
        <span class="barvalue">${escapeHtml(fmt.num(entry.count))}<em>${((entry.count / total) * 100).toFixed(0)}%</em></span>
      </li>`,
    )
    .join('')}</ul>`;
}

/** Models per nation, the headline chart of the page. */
export function countryChart(rows) {
  return countChart((rows ?? []).map((row) => ({ label: row.country, count: row.count })), 'no models in the snapshot yet');
}

/** Models per producing lab, across every nation. */
export function producerChart(rows, limit = 12) {
  return countChart(
    producersOf(rows).slice(0, limit).map((producer) => ({ label: producer.org, count: producer.count })),
    'no mapped producer yet',
  );
}

/** The families the curated table does not know, so the gap stays visible. */
export function unmappedList(rows) {
  const unmapped = (rows ?? []).find((row) => !row.mapped);
  if (!unmapped) return '<p class="empty">every family in the snapshot is mapped</p>';
  return `<ul class="orlist">${unmapped.producers
    .map(
      (producer) => `<li title="${escapeHtml(producer.family)}">
        <span class="barlabel">${escapeHtml(producer.family || '(no family)')}</span>
        <span class="orwhen">${escapeHtml(fmt.num(producer.count))}</span>
      </li>`,
    )
    .join('')}</ul>`;
}

/** One row per nation, the grain the page is about. */
export function countriesCsvOf(rows, filters = {}) {
  const lines = ['iso,country,models,share,live,avg_score,producers,producer_families,top_model'];
  for (const row of visibleCountries(rows, filters)) {
    lines.push(
      [
        row.iso,
        row.country,
        row.count,
        row.share.toFixed(4),
        row.live,
        row.avgScore === null ? '' : row.avgScore.toFixed(2),
        row.producers.map((producer) => producer.org).join(' | '),
        row.producers.map((producer) => producer.family).join(' | '),
        row.top?.id ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** One row per model, the finest grain the report can hand to a spreadsheet. */
export function modelsCsvOf(rows, filters = {}) {
  const lines = ['model_id,name,family,producer,country,iso,rank,score,status,free_providers,context_length'];
  for (const row of visibleCountries(rows, filters)) {
    for (const model of row.models) {
      lines.push(
        [
          model.id,
          model.name ?? '',
          familyOf(model),
          originOfModel(model).org,
          row.country,
          row.iso,
          model.rank ?? '',
          model.score ?? '',
          model.status ?? '',
          model.telemetry?.liveFree ?? 0,
          model.contextLength ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function jsonOf(rows, meta = {}) {
  const countries = (rows ?? []).map((row) => ({
    iso: row.iso,
    country: row.country,
    mapped: row.mapped,
    models: row.count,
    live: row.live,
    share: Number(row.share.toFixed(4)),
    avgScore: row.avgScore === null ? null : Number(row.avgScore.toFixed(2)),
    producers: row.producers,
    modelIds: row.models.map((model) => model.id),
  }));
  return `${JSON.stringify({ ...meta, countries }, null, 2)}\n`;
}

const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
