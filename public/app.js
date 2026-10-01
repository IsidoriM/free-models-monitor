const el = (id) => document.getElementById(id);

const state = {
  snapshot: null,
  history: new Map(),
  sort: 'score',
  query: '',
  status: null,
  feed: [],
  lastSnapshotAt: 0,
  dupes: { status: { state: 'unavailable' }, result: null },
};

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

function renderRows() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const query = state.query.trim().toLowerCase();
  const models = [...snapshot.models]
    .filter((model) => !query || model.id.toLowerCase().includes(query) || (model.name ?? '').toLowerCase().includes(query))
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

function renderDupesMeta(status) {
  const button = el('dupesScan');
  button.disabled = status.state === 'scanning' || status.state === 'unavailable';
  button.textContent = status.state === 'scanning' ? 'scanning...' : 'scan';

  const label = el('dupesMeta');
  if (status.state === 'unavailable') {
    label.textContent = 'disabled';
    return;
  }
  if (status.state === 'scanning') {
    label.textContent = `${status.phase} ${status.phase === 'walking' ? status.filesSeen.toLocaleString() : status.candidatesHashed.toLocaleString()} files`;
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
    `${status.candidatesHashed.toLocaleString()} hashed`,
  ];
  if (status.unreadable) parts.push(`${status.unreadable} unreadable`);
  if (status.truncated) parts.push('hit the file cap');
  label.textContent = `${parts.join(' \u00b7 ')} \u00b7 scanned ${fmt.time(status.finishedAt)}`;
}

function renderDupes() {
  const status = state.dupes.status ?? {};
  const result = state.dupes.result;
  renderDupesMeta(status);

  const body = el('dupesBody');
  if (status.state === 'unavailable') {
    body.innerHTML = '<p class="empty">duplicate scanner disabled (DUPLICATES_ENABLED=false)</p>';
    return;
  }
  if (status.state === 'scanning') {
    const phase = status.phase === 'hashing' ? status.candidatesHashed : status.filesSeen;
    body.innerHTML = `<p class="empty">${escapeHtml(status.phase)} &hellip; ${phase.toLocaleString()} ${status.phase === 'hashing' ? 'candidates hashed' : 'files seen'}</p>`;
    return;
  }
  if (status.state === 'error') {
    body.innerHTML = `<p class="empty bad">scan failed: ${escapeHtml(status.error ?? 'unknown error')}</p>`;
    return;
  }
  if (status.state !== 'done') {
    body.innerHTML = `<p class="empty">no scan yet &mdash; press <b>scan</b> to hash ${escapeHtml((status.roots ?? []).join(', ') || 'the configured roots')}</p>`;
    return;
  }
  if (!result) {
    body.innerHTML = '<p class="empty">scan produced no report</p>';
    return;
  }

  const { totals, groups, groupsTruncated } = result;
  const cards = [
    ['recoverable', fmt.bytes(totals.wastedBytes), totals.wastedBytes ? 'warn' : 'good'],
    ['groups', totals.groups.toLocaleString(), ''],
    ['copies', totals.duplicateFiles.toLocaleString(), ''],
    ['redundant', totals.wastedFiles.toLocaleString(), ''],
    ['min size', fmt.bytes(result.minSizeBytes), ''],
  ]
    .map(([label, value, tone]) => `<div class="stat ${tone}"><b>${escapeHtml(String(value))}</b><span>${label}</span></div>`)
    .join('');

  const rows = groups
    .map(
      (group) => `<tr data-hash="${escapeHtml(group.shortHash)}">
        <td class="num"><span class="score">${escapeHtml(fmt.bytes(group.wasted))}</span></td>
        <td class="num">${escapeHtml(fmt.bytes(group.size))}</td>
        <td class="num">${group.count}</td>
        <td class="hash" title="sha256 ${escapeHtml(group.hash)}">${escapeHtml(group.shortHash)}</td>
        <td class="paths">${group.paths
          .map(
            (file) =>
              `<span class="path" title="${escapeHtml(file.path)}\u2003\u00b7\u2003modified ${escapeHtml(file.modifiedAt)}">${escapeHtml(file.path)}</span>`,
          )
          .join('')}</td>
      </tr>`,
    )
    .join('');

  body.innerHTML = `<div class="dupestats">${cards}</div>${
    groups.length
      ? `<div class="tablewrap"><table>
          <thead><tr>
            <th class="num">recoverable</th><th class="num">each</th><th class="num">copies</th><th>sha256</th><th>paths</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table></div>${
        groupsTruncated ? `<p class="empty">showing the top ${result.groupsShown} groups by recoverable space</p>` : ''
      }`
      : '<p class="empty">no duplicates found above the size threshold</p>'
  }`;
}

function renderAll() {
  renderStats();
  renderRows();
  renderFeed();
  renderExtras();
  renderErrors();
  renderDupes();
  const status = state.status ?? {};
  el('updated').textContent = `updated ${fmt.time(state.snapshot?.generatedAt)}`;
  el('next').textContent = `next poll ${fmt.time(status.nextRunAt)}`;
  el('cycle').textContent = `cycle ${status.cycles ?? 0}${status.probeEnabled ? ' \u00b7 probes on' : ''}`;
}

function openDupeDetail(hash) {
  const group = (state.dupes.result?.groups ?? []).find((entry) => entry.shortHash === hash);
  if (!group) return;
  const rows = group.paths
    .map(
      (file) => `<tr>
        <td>${escapeHtml(file.path)}</td>
        <td class="num">${escapeHtml(fmt.bytes(file.size))}</td>
        <td class="num">${escapeHtml(file.modifiedAt.slice(0, 19).replace('T', ' '))}</td>
      </tr>`,
    )
    .join('');
  el('detailBody').innerHTML = `<div class="body">
    <h3>${group.count} identical copies</h3>
    <div class="sub">${escapeHtml(fmt.bytes(group.size))} each &middot; ${escapeHtml(fmt.bytes(group.wasted))} recoverable &middot; sha256 ${escapeHtml(group.hash)}</div>
    <p>Byte-for-byte identical (SHA-256), so every copy after the first is redundant. This panel only reports &mdash; review the paths and delete them yourself.</p>
    <table><thead><tr><th>path</th><th class="num">size</th><th class="num">modified</th></tr></thead>
      <tbody>${rows}</tbody></table>
  </div>`;
  el('detail').showModal();
}

async function startDupeScan() {
  el('dupesScan').disabled = true;
  try {
    const response = await fetch('/api/duplicates/scan', { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
    state.dupes.status = payload.status ?? { ...state.dupes.status, state: 'scanning' };
    renderDupes();
  } catch (error) {
    state.dupes.status = { ...state.dupes.status, state: 'error', error: error.message };
    renderDupes();
  }
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
  events.addEventListener('duplicates', (event) => {
    state.dupes = JSON.parse(event.data);
    renderDupes();
  });
  events.onerror = () => setPulse('stale');
}

function setPulse(mode) {
  const pulse = el('pulse');
  pulse.className = `pulse ${mode}`;
  el('source').textContent = mode === 'live' ? 'openrouter \u00b7 live' : mode === 'stale' ? 'openrouter \u00b7 reconnecting' : 'openrouter';
}

function openDetail(id) {
  const model = (state.snapshot?.models ?? []).find((m) => m.id === id) ?? (state.snapshot?.extras ?? []).find((m) => m.id === id);
  if (!model) return;
  const kv = (label, value) => `<div class="kv"><span>${label}</span><span>${escapeHtml(String(value ?? '-'))}</span></div>`;
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
    <div class="grid2">
      ${kv('context window', fmt.ctx(model.contextLength) === '-' ? '-' : model.contextLength.toLocaleString())}
      ${kv('max output tokens', model.maxOutputTokens?.toLocaleString() ?? '-')}
      ${kv('modality', model.modality ?? '-')}
      ${kv('tokenizer', model.tokenizer ?? '-')}
      ${kv('free providers', model.telemetry.liveFree)}
      ${kv('providers total', model.endpoints.length)}
      ${kv('best uptime 5m', fmt.pct(model.telemetry.bestUptime5m))}
      ${kv('best uptime 24h', fmt.pct(model.telemetry.bestUptime1d))}
      ${kv('latency 30m', fmt.ms(model.telemetry.bestLatencyMs))}
      ${kv('throughput 30m', fmt.tps(model.telemetry.bestThroughputTps))}
      ${kv('intelligence index', model.benchmarks?.intelligence ?? 'unpublished')}
      ${kv('coding / agentic', `${model.benchmarks?.coding ?? '-'} / ${model.benchmarks?.agentic ?? '-'}`)}
      ${kv('created', model.createdAt?.slice(0, 10) ?? '-')}
      ${kv('expires', model.expiresAt ? `${model.expiresAt.slice(0, 10)} (${model.expiry.daysLeft}d left)` : 'never')}
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
});
el('rows').addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-id]');
  if (row) openDetail(row.dataset.id);
});
el('extrasList').addEventListener('click', (event) => {
  const item = event.target.closest('li[data-id]');
  if (item) openDetail(item.dataset.id);
});
el('detailClose').addEventListener('click', () => el('detail').close());
el('dupesScan').addEventListener('click', startDupeScan);
el('dupesBody').addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-hash]');
  if (row) openDupeDetail(row.dataset.hash);
});

setInterval(() => {
  const age = Date.now() - state.lastSnapshotAt;
  if (state.lastSnapshotAt && age > 150_000) setPulse('dead');
}, 10_000);

renderAll();
connect();