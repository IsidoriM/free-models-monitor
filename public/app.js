const el = (id) => document.getElementById(id);

const state = {
  snapshot: null,
  history: new Map(),
  sort: 'score',
  query: '',
  status: null,
  feed: [],
  lastSnapshotAt: 0,
  trojans: { status: { state: 'idle' }, result: null },
};

/** Characteristics shown on the cards; the detail dialog lists all of them. */
const CARD_KEYS = [
  'context',
  'output',
  'modality',
  'tokenizer',
  'providers',
  'uptime5m',
  'uptime1d',
  'latency',
  'throughput',
  'intelligence',
  'created',
  'expires',
];

const SORT_KEYS = {
  score: (m) => -m.score,
  uptime: (m) => -(m.telemetry.bestUptime5m ?? -1),
  latency: (m) => m.telemetry.bestLatencyMs ?? Number.MAX_SAFE_INTEGER,
  context: (m) => -(m.contextLength ?? 0),
  providers: (m) => -m.telemetry.liveFree,
  rank: (m) => m.rank,
};

const fmt = {
  pct: (v) => (v === null || v === undefined ? 'n/a' : `${v.toFixed(1)}%`),
  ms: (v) => (v === null || v === undefined ? 'n/a' : `${v} ms`),
  tps: (v) => (v === null || v === undefined ? 'n/a' : `${v} tok/s`),
  ctx: (v) => (v ? `${(v / 1000).toFixed(v >= 1_000_000 ? 0 : 0)}k` : '-'),
  time: (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) : '-'),
  bytes: (v) => {
    if (v === null || v === undefined) return 'n/a';
    if (v < 1024) return `${v} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = v / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ${units[unit]}`;
  },
};

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function statusClass(model) {
  if (model.status === 'unavailable') return 'down';
  if (model.expiry?.state === 'expiring') return 'warn';
  return 'live';
}

function statusLabel(model) {
  if (model.status === 'unavailable') return 'no live provider';
  if (model.expiry?.state === 'expiring') return `expires in ${model.expiry.daysLeft}d`;
  return 'live';
}

function uptimeBar(value) {
  const pct = Math.max(0, Math.min(100, value ?? 0));
  const tone = value === null ? 'warn' : value >= 99 ? '' : value >= 95 ? 'warn' : 'bad';
  return `<span class="bar ${tone}"><span style="width:${pct}%"></span></span>`;
}

function sparkline(id, width = 84, height = 16) {
  const samples = state.history.get(id) ?? [];
  if (samples.length < 2) return `<svg class="spark" width="${width}" height="${height}"></svg>`;
  const values = samples.map((sample) => sample.score);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const points = values
    .map((value, index) => `${(index * step).toFixed(1)},${(height - ((value - min) / span) * (height - 3) - 1.5).toFixed(1)}`)
    .join(' ');
  const trend = values.at(-1) >= values[0] ? 'var(--green)' : 'var(--red)';
  return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <polyline points="${points}" fill="none" stroke="${trend}" stroke-width="1.4" stroke-linejoin="round" />
  </svg>`;
}

function scoreMix(model) {
  const parts = [
    ['a', model.components.availability],
    ['c', model.components.capability],
    ['x', model.components.context],
    ['f', model.components.features],
    ['r', model.components.recency],
    ['b', model.components.breadth],
  ];
  return `<span class="mix">${parts
    .map(([cls, value]) => `<i class="${cls}" style="flex:${Math.max(0.02, value / 10)}" title="${cls}: ${value}"></i>`)
    .join('')}</span>`;
}

function deltaHtml(delta) {
  if (delta === null || delta === undefined) return '<span class="delta new">NEW</span>';
  if (delta === 0) return '<span class="delta" style="color:var(--muted)">-</span>';
  const cls = delta > 0 ? 'up' : 'down';
  return `<span class="delta ${cls}">${delta > 0 ? '\u25b2' : '\u25bc'} ${Math.abs(delta)}</span>`;
}

function matchesQuery(model) {
  const query = state.query.trim().toLowerCase();
  if (!query) return true;
  return model.id.toLowerCase().includes(query) || (model.name ?? '').toLowerCase().includes(query);
}

function reasoningLabel(reasoning) {
  if (!reasoning || typeof reasoning !== 'object') return 'no';
  if (reasoning.mandatory) return 'yes, always on';
  if (reasoning.default_enabled) return 'yes, on by default';
  return 'yes, opt-in';
}

/** Short badges for what a model can actually do, derived from the raw metadata. */
function capabilityTags(model) {
  const parameters = model.supportedParameters ?? [];
  const modality = model.modality ?? '';
  const tags = [];
  const reasoning = reasoningLabel(model.reasoning);
  if (reasoning !== 'no') tags.push(reasoning);
  if (parameters.includes('tools') || parameters.includes('tool_choice')) tags.push('tools');
  if (parameters.includes('structured_outputs')) tags.push('structured output');
  if (parameters.includes('response_format')) tags.push('json mode');
  for (const [needle, label] of [['image', 'vision'], ['audio', 'audio'], ['video', 'video']]) {
    if (modality.includes(needle)) tags.push(label);
  }
  if (model.moderated) tags.push('moderated');
  if (model.huggingFaceId) tags.push('hugging face');
  if (model.estimatedCapability) tags.push('capability estimated');
  return tags;
}

/**
 * One row per characteristic of a model. The dashboard cards and the detail
 * dialog both read from here, so the two views can never drift apart.
 */
function modelCharacteristics(model) {
  const telemetry = model.telemetry ?? {};
  const benchmarks = model.benchmarks ?? {};
  const providers = telemetry.freeProviders ?? [];
  const parameters = model.supportedParameters ?? [];
  const index = (value) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : 'n/a');
  const tokens = (value) => (typeof value === 'number' && value > 0 ? value.toLocaleString() : '-');

  return [
    { key: 'context', label: 'context window', value: tokens(model.contextLength) },
    { key: 'output', label: 'max output tokens', value: tokens(model.maxOutputTokens) },
    { key: 'modality', label: 'modality', value: model.modality || (model.inputModalities ?? []).join('+') || '-' },
    { key: 'tokenizer', label: 'tokenizer', value: model.tokenizer ?? '-' },
    {
      key: 'providers',
      label: 'free providers',
      value: `${telemetry.liveFree ?? 0} live / ${model.endpoints?.length ?? 0}`,
      title: providers.join(', ') || 'no free endpoint',
    },
    { key: 'uptime5m', label: 'uptime 5m', value: fmt.pct(telemetry.bestUptime5m) },
    { key: 'uptime1d', label: 'uptime 24h', value: fmt.pct(telemetry.bestUptime1d) },
    { key: 'latency', label: 'latency 30m', value: fmt.ms(telemetry.bestLatencyMs) },
    { key: 'throughput', label: 'throughput 30m', value: fmt.tps(telemetry.bestThroughputTps) },
    { key: 'intelligence', label: 'intelligence index', value: index(benchmarks.intelligence) },
    { key: 'coding', label: 'coding index', value: index(benchmarks.coding) },
    { key: 'agentic', label: 'agentic index', value: index(benchmarks.agentic) },
    { key: 'created', label: 'created', value: model.createdAt?.slice(0, 10) ?? '-' },
    {
      key: 'expires',
      label: 'expires',
      value: model.expiresAt ? `${model.expiresAt.slice(0, 10)} (${model.expiry?.daysLeft ?? '?'}d left)` : 'never',
    },
    { key: 'reasoning', label: 'reasoning', value: reasoningLabel(model.reasoning) },
    { key: 'moderated', label: 'moderated', value: model.moderated === null || model.moderated === undefined ? 'n/a' : model.moderated ? 'yes' : 'no' },
    { key: 'parameters', label: 'parameters', value: `${parameters.length}`, title: parameters.join(', ') || 'none reported' },
    { key: 'huggingface', label: 'hugging face id', value: model.huggingFaceId ?? '-' },
  ];
}

function tagChips(labels, tone = '') {
  const cls = tone ? `tag ${tone}` : 'tag';
  return labels.map((label) => `<span class="${cls}">${escapeHtml(label)}</span>`).join('');
}

const specHtml = (spec) => `<div class="spec"${spec.title ? ` title="${escapeHtml(spec.title)}"` : ''}>
  <dt>${escapeHtml(spec.label)}</dt>
  <dd title="${escapeHtml(spec.value)}">${escapeHtml(spec.value)}</dd>
</div>`;

/**
 * The characteristics dashboard: one card per top 20 model with its description,
 * its specs and its free providers. Rank order is kept whatever the board sorts by.
 */
function renderCharacteristics() {
  const snapshot = state.snapshot;
  const container = el('cards');
  if (!snapshot) return;

  const models = snapshot.models.filter(matchesQuery).sort((a, b) => a.rank - b.rank);
  el('characteristicsMeta').textContent = state.query.trim()
    ? `${models.length} of ${snapshot.models.length} match "${state.query.trim()}"`
    : `all ${models.length} top models, ordered by rank`;

  if (!models.length) {
    container.innerHTML = '<p class="empty">no tracked model matches the search</p>';
    return;
  }

  container.innerHTML = models
    .map((model) => {
      const description = (model.description ?? '').trim() || 'no description published upstream';
      const specs = modelCharacteristics(model).filter((spec) => CARD_KEYS.includes(spec.key));
      const providers = model.telemetry?.freeProviders ?? [];
      const scoreDelta = model.scoreDelta
        ? `<small>${model.scoreDelta > 0 ? '+' : ''}${model.scoreDelta.toFixed(1)}</small>`
        : '';
      return `<article class="mcard" data-id="${escapeHtml(model.id)}">
        <header class="mcardhead">
          <span class="rank">#${model.rank}</span>
          <div class="mcardname">
            <span class="name" title="${escapeHtml(model.name ?? model.id)}">${escapeHtml(model.name ?? model.id)}</span>
            <span class="path" title="${escapeHtml(model.id)}">${escapeHtml(model.id)}</span>
          </div>
          <span class="score">${model.score.toFixed(1)}${scoreDelta}</span>
        </header>
        <div class="tags">${tagChips([statusLabel(model)], statusClass(model))}${tagChips(capabilityTags(model))}</div>
        <p class="mcarddesc" title="${escapeHtml(description)}">${escapeHtml(description)}</p>
        <dl class="mcardspecs">${specs.map(specHtml).join('')}</dl>
        <footer class="mcardfoot">
          <span class="mcardprovs" title="${escapeHtml(providers.join(', ') || 'no free provider')}">
            ${tagChips(providers.length ? providers.slice(0, 3) : ['no free provider'])}
          </span>
          ${scoreMix(model)}
        </footer>
      </article>`;
    })
    .join('');
}

function renderRows() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const query = state.query.trim().toLowerCase();
  const models = [...snapshot.models]
    .filter(matchesQuery)
    .sort((a, b) => {
      const primary = (SORT_KEYS[state.sort] ?? SORT_KEYS.score)(a) - (SORT_KEYS[state.sort] ?? SORT_KEYS.score)(b);
      return primary || a.rank - b.rank;
    });

  el('countLabel').textContent = `(${models.length} of ${snapshot.counts.tracked})`;
  el('rows').innerHTML = models
    .map((model) => {
      const tone = statusClass(model);
      const follow = query && !`${model.id} ${model.name}`.toLowerCase().includes(query) ? ' dim' : '';
      const estimate = model.estimatedCapability ? '<span class="tag" title="no published benchmark: capability scored neutrally">est</span>' : '';
      return `<tr class="${follow}" data-id="${escapeHtml(model.id)}">
        <td class="num rank">${model.rank}</td>
        <td>
          <div class="name">
            <span class="id" title="${escapeHtml(model.description ?? '')}">${escapeHtml(model.id)}</span>
            <span class="tags">
              <span class="tag ${tone}">${escapeHtml(statusLabel(model))}</span>
              ${model.modality && model.modality !== 'text->text' ? `<span class="tag">${escapeHtml(model.modality)}</span>` : ''}
              ${estimate}
              ${model.huggingFaceId ? '<span class="tag">hf</span>' : ''}
            </span>
          </div>
        </td>
        <td class="num"><span class="score">${model.score.toFixed(1)}</span>${
          model.scoreDelta ? ` <small>${model.scoreDelta > 0 ? '+' : ''}${model.scoreDelta.toFixed(1)}</small>` : ''
        }</td>
        <td class="num">${uptimeBar(model.telemetry.bestUptime5m)} ${fmt.pct(model.telemetry.bestUptime5m)}</td>
        <td class="num">${fmt.ms(model.telemetry.bestLatencyMs)}</td>
        <td class="num">${fmt.ctx(model.contextLength)}</td>
        <td title="${escapeHtml((model.telemetry.freeProviders ?? []).join(', '))}">
          ${model.telemetry.liveFree} <span class="tag">${escapeHtml((model.telemetry.freeProviders ?? []).slice(0, 2).join(', ') || 'none')}</span>
        </td>
        <td>${sparkline(model.id)}</td>
        <td>${scoreMix(model)}</td>
      </tr>`;
    })
    .join('');
}

function renderStats() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const avgUptime = snapshot.models.filter((m) => m.telemetry.bestUptime5m !== null);
  const mean = avgUptime.length
    ? avgUptime.reduce((sum, m) => sum + m.telemetry.bestUptime5m, 0) / avgUptime.length
    : null;
  const cards = [
    ['tracked', snapshot.counts.tracked, ''],
    ['live', snapshot.counts.live, 'good'],
    ['down', snapshot.counts.unavailable, snapshot.counts.unavailable ? 'bad' : ''],
    ['avg uptime', mean === null ? 'n/a' : `${mean.toFixed(1)}%`, mean !== null && mean < 95 ? 'warn' : 'good'],
    ['free models', snapshot.counts.free ?? 'n/a', ''],
    ['catalog', snapshot.counts.catalogTotal ?? 'n/a', ''],
  ];
  el('stats').innerHTML = cards
    .map(([label, value, tone]) => `<div class="stat ${tone}"><b>${escapeHtml(String(value))}</b><span>${label}</span></div>`)
    .join('');
}

function renderFeed() {
  if (!state.feed.length) {
    el('feedList').innerHTML = '<li class="empty">no changes yet - waiting for the next poll</li>';
    return;
  }
  const arrow = { 'rank-up': ['\u25b2', 'up'], 'rank-down': ['\u25bc', 'down'], entered: ['\u2022', 'new'], dropped: ['\u2715', 'dropped'], status: ['\u25cf', 'new'] };
  el('feedList').innerHTML = state.feed
    .slice(0, 40)
    .map((change) => {
      const [glyph, cls] = arrow[change.type] ?? ['\u2022', 'new'];
      const message = {
        entered: `entered top ${change.rank}`,
        'rank-up': `#${change.from} \u2192 #${change.to}`,
        'rank-down': `#${change.from} \u2192 #${change.to}`,
        dropped: `dropped out of top ${change.from}`,
        status: `${change.from} \u2192 ${change.to}`,
      }[change.type];
      return `<li>
        <time>${fmt.time(new Date(change.at).toISOString())}</time>
        <span class="arrow ${cls}">${glyph}</span>
        <span class="msg">${escapeHtml(change.modelName ?? change.modelId ?? '')} &middot; ${escapeHtml(message ?? change.type)}</span>
      </li>`;
    })
    .join('');
}

function renderExtras() {
  const extras = state.snapshot?.extras ?? [];
  if (!extras.length) {
    el('extrasList').innerHTML = '<li class="empty">no other free models found</li>';
    return;
  }
  el('extrasList').innerHTML = extras
    .map(
      (model) => `<li data-id="${escapeHtml(model.id)}">
        <span>${escapeHtml(model.id)}</span>
        <span class="s">${model.score.toFixed(1)}${
          model.telemetry.bestUptime5m === null ? '' : ` &middot; ${model.telemetry.bestUptime5m.toFixed(1)}%`
        }</span>
      </li>`,
    )
    .join('');
}

function renderErrors() {
  const failures = state.snapshot?.failures ?? [];
  el('errors').textContent = failures.length
    ? `${failures.length} endpoint fetch failure(s): ${failures.map((f) => `${f.id} (${f.status ?? 'net'})`).join(', ')}`
    : '';
}

const SEVERITY_CLASS = { high: 'sev-high', medium: 'sev-med', low: 'sev-low' };

function renderTrojansMeta(status) {
  const scan = el('trojansScan');
  const cancel = el('trojansCancel');
  scan.disabled = status.state === 'scanning' || status.state === 'unavailable';
  scan.textContent = status.state === 'scanning' ? 'scanning...' : 'scan';
  cancel.disabled = status.state !== 'scanning';

  const label = el('trojansMeta');
  if (status.state === 'unavailable') {
    label.textContent = 'disabled';
    return;
  }
  if (status.state === 'scanning') {
    const count = status.phase === 'inspecting' ? status.inspected : status.filesSeen;
    label.textContent = `${status.phase} ${count.toLocaleString()} files`;
    return;
  }
  if (status.state === 'cancelled') {
    label.textContent = 'cancelled';
    return;
  }
  if (status.state === 'error') {
    label.textContent = `failed: ${status.error ?? 'unknown error'}`;
    return;
  }
  if (status.state !== 'done') {
    label.textContent = 'not scanned yet';
    return;
  }
  const parts = [
    `${(status.durationMs / 1000).toFixed(1)}s`,
    `${status.filesSeen.toLocaleString()} files walked`,
    `${status.inspected.toLocaleString()} read`,
    `${status.findings.toLocaleString()} suspects`,
  ];
  if (status.unreadable) parts.push(`${status.unreadable} unreadable`);
  if (status.truncated) parts.push('hit the file cap');
  label.textContent = `${parts.join(' \u00b7 ')} \u00b7 scanned ${fmt.time(status.finishedAt)}`;
}

function renderTrojans() {
  const status = state.trojans.status ?? {};
  const result = state.trojans.result;
  renderTrojansMeta(status);

  const body = el('trojansBody');
  if (status.state === 'unavailable') {
    body.innerHTML = '<p class="empty">trojan scanner disabled (TROJANS_ENABLED=false)</p>';
    return;
  }
  if (status.state === 'scanning') {
    const count = status.phase === 'inspecting' ? status.inspected : status.filesSeen;
    const unit = status.phase === 'inspecting' ? 'files inspected' : 'files seen';
    body.innerHTML = `<p class="empty">${escapeHtml(status.phase)} &hellip; ${count.toLocaleString()} ${unit}</p>`;
    return;
  }
  if (status.state === 'error') {
    body.innerHTML = `<p class="empty bad">scan failed: ${escapeHtml(status.error ?? 'unknown error')}</p>`;
    return;
  }
  if (status.state !== 'done') {
    body.innerHTML = `<p class="empty">no scan yet &mdash; press <b>scan</b> to inspect ${escapeHtml((status.roots ?? []).join(', ') || 'the configured roots')}</p>`;
    return;
  }
  if (!result) {
    body.innerHTML = '<p class="empty">scan produced no report</p>';
    return;
  }

  const { totals, findings, findingsTruncated, topRules } = result;
  const cards = [
    ['suspects', totals.findings.toLocaleString(), totals.high ? 'bad' : 'good'],
    ['high', totals.high.toLocaleString(), totals.high ? 'bad' : ''],
    ['medium', totals.medium.toLocaleString(), totals.medium ? 'warn' : ''],
    ['low', totals.low.toLocaleString(), ''],
    ['inspected', totals.inspected.toLocaleString(), ''],
    ['suspect bytes', fmt.bytes(totals.bytes), ''],
  ]
    .map(([label, value, tone]) => `<div class="stat ${tone}"><b>${escapeHtml(String(value))}</b><span>${label}</span></div>`)
    .join('');

  const chips = topRules.length
    ? `<div class="rulechips">${topRules
        .map((rule) => `<span class="chip" title="${escapeHtml(rule.label)}">${escapeHtml(rule.label)} &middot; ${rule.count}</span>`)
        .join('')}</div>`
    : '';

  const rows = findings
    .map(
      (finding) => `<tr data-path="${escapeHtml(finding.path)}" class="${finding.severity === 'low' ? 'dim' : ''}">
        <td><span class="sev ${SEVERITY_CLASS[finding.severity]}">${escapeHtml(finding.severity)}</span></td>
        <td class="num">${finding.score}</td>
        <td class="num">${escapeHtml(fmt.bytes(finding.size))}</td>
        <td class="num" title="${escapeHtml(finding.modifiedAt)}">${finding.ageDays}d</td>
        <td class="paths"><span class="path" title="${escapeHtml(finding.path)}">${escapeHtml(finding.path)}</span></td>
        <td class="signals">${finding.reasons
          .map((reason) => `<span class="signal">${escapeHtml(reason.label)}</span>`)
          .join('')}</td>
      </tr>`,
    )
    .join('');

  body.innerHTML = `<div class="scanstats">${cards}</div>${chips}${
    findings.length
      ? `<div class="tablewrap"><table>
          <thead><tr>
            <th>severity</th><th class="num">score</th><th class="num">size</th><th class="num">age</th><th>path</th><th>signals</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table></div>${
        findingsTruncated ? `<p class="empty">showing the top ${result.findingsShown} suspects by score</p>` : ''
      }`
      : '<p class="empty">nothing matched the heuristics &mdash; not a clean bill of health, just no signals</p>'
  }`;
}

function openTrojanDetail(filePath) {
  const finding = (state.trojans.result?.findings ?? []).find((entry) => entry.path === filePath);
  if (!finding) return;
  const rows = finding.reasons
    .map(
      (reason) => `<tr>
        <td>${escapeHtml(reason.label)}</td>
        <td class="num">${reason.weight}</td>
        <td>${escapeHtml(reason.detail ?? '-')}</td>
      </tr>`,
    )
    .join('');
  el('detailBody').innerHTML = `<div class="body">
    <h3>${escapeHtml(finding.name)}</h3>
    <div class="sub">${escapeHtml(finding.severity)} severity &middot; score ${finding.score} &middot; ${escapeHtml(fmt.bytes(finding.size))} &middot; modified ${escapeHtml(finding.modifiedAt.slice(0, 19).replace('T', ' '))}</div>
    <p>${escapeHtml(finding.path)}</p>
    <p>Heuristics only: nothing here proves the file is malware. Open it in an antivirus or Defender scan before running it, check the signature of a real download, and prefer removing a file you cannot explain over keeping one you cannot verify. This panel never deletes, quarantines or executes anything.</p>
    <h4>signals</h4>
    <table><thead><tr><th>rule</th><th class="num">weight</th><th>why</th></tr></thead>
      <tbody>${rows}</tbody></table>
  </div>`;
  el('detail').showModal();
}

async function startTrojanScan() {
  el('trojansScan').disabled = true;
  try {
    const response = await fetch('/api/trojans/scan', { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
    state.trojans.status = payload.status ?? { ...state.trojans.status, state: 'scanning' };
    renderTrojans();
  } catch (error) {
    state.trojans.status = { ...state.trojans.status, state: 'error', error: error.message };
    renderTrojans();
  }
}

async function cancelTrojanScan() {
  el('trojansCancel').disabled = true;
  try {
    const response = await fetch('/api/trojans/cancel', { method: 'POST' });
    const payload = await response.json();
    if (response.ok && payload.status) state.trojans.status = payload.status;
  } catch {
    /* the next update tick carries the real state */
  }
  renderTrojans();
}

async function loadHistory(id) {
  if (state.history.has(id)) return;
  try {
    const response = await fetch(`/api/history?id=${encodeURIComponent(id)}`);
    if (!response.ok) return;
    const data = await response.json();
    state.history.set(id, data.samples);
  } catch {
    /* history is optional decoration */
  }
}

function connect() {
  const events = new EventSource('/api/events');

  events.addEventListener('open', () => setPulse('live'));
  events.addEventListener('snapshot', (event) => {
    const snapshot = JSON.parse(event.data);
    state.snapshot = snapshot;
    state.status = snapshot.status ?? state.status;
    state.lastSnapshotAt = Date.now();
    setPulse('live');
    for (const model of snapshot.models.slice(0, 20)) loadHistory(model.id);
    renderAll();
  });
  events.addEventListener('changes', (event) => {
    const { changes } = JSON.parse(event.data);
    state.feed = [...changes.reverse(), ...state.feed].slice(0, 60);
    renderFeed();
  });
  events.addEventListener('error', () => setPulse('stale'));
events.addEventListener('trojans', (event) => {
    state.trojans = JSON.parse(event.data);
    renderTrojans();
  });
  events.onerror = () => setPulse('stale');
}

function setPulse(mode) {
  const pulse = el('pulse');
  pulse.className = `pulse ${mode}`;
  el('source').textContent = mode === 'live' ? 'openrouter \u00b7 live' : mode === 'stale' ? 'openrouter \u00b7 reconnecting' : 'openrouter';
}

function renderAll() {
  renderStats();
  renderRows();
  renderCharacteristics();
  renderFeed();
  renderExtras();
  renderErrors();
  renderTrojans();
  const status = state.status ?? {};
  el('updated').textContent = `updated ${fmt.time(state.snapshot?.generatedAt)}`;
  el('next').textContent = `next poll ${fmt.time(status.nextRunAt)}`;
  el('cycle').textContent = `cycle ${status.cycles ?? 0}${status.probeEnabled ? ' \u00b7 probes on' : ''}`;
}

function openDetail(id) {
  const model = (state.snapshot?.models ?? []).find((m) => m.id === id) ?? (state.snapshot?.extras ?? []).find((m) => m.id === id);
  if (!model) return;
  const kv = (label, value) => `<div class="kv"><span>${label}</span><span>${escapeHtml(String(value ?? '-'))}</span></div>`;
  const characteristics = modelCharacteristics(model).map((spec) => kv(spec.label, spec.value)).join('');
  const capabilities = capabilityTags(model);
  const endpointRows = model.endpoints
    .filter((endpoint) => endpoint.free)
    .map(
      (endpoint) => `<tr>
        <td>${escapeHtml(endpoint.provider)}</td>
        <td>${endpoint.live ? 'live' : `status ${endpoint.status}`}</td>
        <td class="num">${fmt.pct(endpoint.uptime5m)}</td>
        <td class="num">${fmt.ms(endpoint.latencyMs)}</td>
        <td class="num">${fmt.tps(endpoint.throughputTps)}</td>
        <td>${escapeHtml(endpoint.quantization ?? '-')}</td>
      </tr>`,
    )
    .join('');

  el('detailBody').innerHTML = `<div class="body">
    <h3>${escapeHtml(model.id)}</h3>
    <div class="sub">${escapeHtml(model.name ?? '')} &middot; rank #${model.rank ?? '-'} &middot; score ${model.score.toFixed(1)} &middot; <a href="${escapeHtml(model.url)}" target="_blank" rel="noreferrer">openrouter</a></div>
    <p>${escapeHtml(model.description ?? 'no description')}</p>
    ${capabilities.length ? `<h4>capabilities</h4><div class="capabilities">${tagChips(capabilities)}</div>` : ''}
    <h4>characteristics</h4>
    <div class="grid2">
      ${characteristics}
      ${model.probe ? kv('probe', `${model.probe.ok ? 'ok' : 'fail'} in ${model.probe.latencyMs}ms`) : ''}
    </div>
    <h4>score mix</h4>
    <div class="grid2">
      ${Object.entries(model.components).map(([key, value]) => kv(key, value)).join('')}
    </div>
    <h4>free providers</h4>
    <table><thead><tr><th>provider</th><th>state</th><th class="num">uptime 5m</th><th class="num">latency</th><th class="num">throughput</th><th>quant</th></tr></thead>
      <tbody>${endpointRows || '<tr><td colspan="6">no free endpoints</td></tr>'}</tbody></table>
    <h4>supported parameters</h4>
    <p>${escapeHtml((model.supportedParameters ?? []).join(', ') || 'none reported')}</p>
  </div>`;
  el('detail').showModal();
}

el('sort').addEventListener('change', (event) => {
  state.sort = event.target.value;
  renderRows();
});
el('search').addEventListener('input', (event) => {
  state.query = event.target.value;
  renderRows();
  renderCharacteristics();
});
el('rows').addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-id]');
  if (row) openDetail(row.dataset.id);
});
el('cards').addEventListener('click', (event) => {
  const card = event.target.closest('.mcard[data-id]');
  if (card) openDetail(card.dataset.id);
});
el('extrasList').addEventListener('click', (event) => {
  const item = event.target.closest('li[data-id]');
  if (item) openDetail(item.dataset.id);
});
el('detailClose').addEventListener('click', () => el('detail').close());
el('trojansScan').addEventListener('click', startTrojanScan);
el('trojansCancel').addEventListener('click', cancelTrojanScan);
el('trojansBody').addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-path]');
  if (row) openTrojanDetail(row.dataset.path);
});

setInterval(() => {
  const age = Date.now() - state.lastSnapshotAt;
  if (state.lastSnapshotAt && age > 150_000) setPulse('dead');
}, 10_000);

renderAll();
connect();
