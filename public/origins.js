import {
  TABLE_LIMIT,
  countriesCsvOf,
  countriesOf,
  countryChart,
  defaultDirection,
  escapeHtml,
  fmt,
  jsonOf,
  modelsCsvOf,
  producerChart,
  summarize,
  unmappedList,
  visibleCountries,
} from './origins-report.js';

const el = (id) => document.getElementById(id);

const state = {
  snapshot: null,
  rows: [],
  query: '',
  sortKey: 'models',
  sortDir: -1,
  onlyLive: false,
  includeExtras: true,
  connected: false,
  lastSnapshotAt: 0,
};

function models() {
  const tracked = state.snapshot?.models ?? [];
  return state.includeExtras ? [...tracked, ...(state.snapshot?.extras ?? [])] : tracked;
}

function filters() {
  return { query: state.query, onlyLive: state.onlyLive, sortKey: state.sortKey, sortDir: state.sortDir };
}

function score(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '-';
}

function statusTone(model) {
  if (model.status === 'unavailable') return 'down';
  if (model.expiry?.state === 'expiring') return 'warn';
  return 'live';
}

function renderKpis() {
  const summary = summarize(models());
  const leader = summary.leader;
  const cards = [
    ['models', fmt.num(summary.models), '', 'tracked free models the page groups'],
    ['nations', fmt.num(summary.countries), '', 'countries with at least one mapped model'],
    ['producers', fmt.num(summary.producers), '', 'labs behind those models'],
    ['live', fmt.num(summary.live), '', 'models with a live free endpoint'],
    [
      'leader',
      leader ? leader.country : '-',
      '',
      leader ? `${leader.count} of ${summary.models} models come from ${leader.country}` : 'nothing mapped yet',
    ],
    [
      'unmapped',
      fmt.num(summary.unmappedModels),
      summary.unmappedModels ? 'warn' : '',
      `${fmt.num(summary.unmappedProducers)} famil${summary.unmappedProducers === 1 ? 'y is' : 'ies are'} not in the curated table`,
    ],
  ];
  el('kpis').innerHTML = cards
    .map(
      ([label, value, tone, title]) =>
        `<div class="stat ${tone}" title="${escapeHtml(title)}"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`,
    )
    .join('');
}

function labChips(row) {
  if (!row.producers.length) return '<span class="hint">no producer mapped</span>';
  return row.producers
    .map(
      (producer) =>
        `<span class="tag" title="${escapeHtml(`${producer.family} \u00b7 ${fmt.num(producer.count)} model(s)`)}">${escapeHtml(producer.org)} ${escapeHtml(fmt.num(producer.count))}</span>`,
    )
    .join('');
}

function rowHtml(row, max, index) {
  const width = max > 0 ? Math.max(1.5, (row.count / max) * 100) : 0;
  const top = row.top ? escapeHtml(row.top.id) : '-';
  return `<tr data-country="${escapeHtml(row.iso)}" tabindex="0">
    <td class="num">${index + 1}</td>
    <td class="orcountry">
      <div class="orhead">
        <span class="oriso${row.mapped ? '' : ' unknown'}" title="ISO 3166-1 alpha-2">${escapeHtml(row.iso)}</span>
        <span class="orname">${escapeHtml(row.country)}</span>
      </div>
      <div class="orlabs">${labChips(row)}</div>
    </td>
    <td class="num"><span class="orbar"><span style="width:${width.toFixed(2)}%"></span></span><b>${escapeHtml(fmt.num(row.count))}</b></td>
    <td class="num">${escapeHtml(fmt.pct(row.share))}</td>
    <td class="num">${escapeHtml(fmt.num(row.live))}</td>
    <td class="num">${escapeHtml(score(row.avgScore))}</td>
    <td class="orwhen" title="${top}">${top}</td>
  </tr>`;
}

function renderCountries() {
  const body = el('countriesBody');
  const bail = (message) => {
    body.innerHTML = `<p class="empty">${message}</p>`;
  };

  if (!state.snapshot) return bail('no snapshot yet &mdash; the monitor is still polling openrouter');

  const rows = visibleCountries(state.rows, filters());
  if (!rows.length) return bail('no nation matches the current filters');

  const shown = rows.slice(0, TABLE_LIMIT);
  const max = rows.reduce((best, row) => Math.max(best, row.count), 0);
  body.innerHTML = `<div class="tablewrap"><table class="ortable">
    <thead><tr>
      <th class="num">#</th>
      <th data-sort="country">nation</th>
      <th class="num" data-sort="models">models</th>
      <th class="num">share</th>
      <th class="num" data-sort="live">live</th>
      <th class="num" data-sort="score">avg score</th>
      <th>best model</th>
    </tr></thead>
    <tbody>${shown.map((row, index) => rowHtml(row, max, index)).join('')}</tbody>
  </table></div>${
    rows.length > shown.length ? `<p class="empty">showing the first ${fmt.num(shown.length)} of ${fmt.num(rows.length)} nations</p>` : ''
  }`;
}

function renderStatePanel() {
  const snapshot = state.snapshot ?? {};
  const status = state.snapshot?.status ?? {};
  const catalog = snapshot.catalog ?? {};
  const counts = snapshot.counts ?? {};
  const rows = [
    ['top board', fmt.num((snapshot.models ?? []).length)],
    ['watchlist shown', state.includeExtras ? fmt.num((snapshot.extras ?? []).length) : 'hidden'],
    ['catalog free', fmt.num(catalog.freeModels)],
    ['resolved', fmt.num(catalog.resolvedModels)],
    ['live / unavailable', `${fmt.num(counts.live)} / ${fmt.num(counts.unavailable)}`],
    ['expiring soon', fmt.num(counts.expiringSoon)],
    ['poll duration', fmt.duration(snapshot.durationMs)],
    ['failures', fmt.num((snapshot.failures ?? []).length)],
    ['cycle', fmt.num(status.cycles ?? 0)],
    ['next poll', fmt.time(status.nextRunAt)],
  ];
  if (status.error) rows.push(['error', status.error]);

  const note = state.snapshot
    ? '<p class="note">same payload the main dashboard renders: this page only groups it by nation, it never refetches.</p>'
    : '<p class="note">waiting for the first snapshot.</p>';

  el('statePanel').innerHTML = `<div class="kvlist">${rows
    .map(([label, value]) => `<div class="kv"><span>${escapeHtml(label)}</span><span>${escapeHtml(String(value))}</span></div>`)
    .join('')}</div>${note}`;
}

function openDetail(iso) {
  const row = state.rows.find((entry) => entry.iso === iso);
  if (!row) return;

  const kv = (label, value) => `<div class="kv"><span>${escapeHtml(label)}</span><span>${escapeHtml(String(value))}</span></div>`;
  const producers = row.producers
    .map(
      (producer) => `<tr>
        <td>${escapeHtml(producer.org)}</td>
        <td>${escapeHtml(producer.family)}</td>
        <td class="num">${escapeHtml(fmt.num(producer.count))}</td>
      </tr>`,
    )
    .join('');
  const models = row.models
    .map(
      (model) => `<tr>
        <td><a href="${escapeHtml(model.url ?? '#')}" target="_blank" rel="noreferrer">${escapeHtml(model.id)}</a></td>
        <td class="num">${escapeHtml(model.rank ? `#${model.rank}` : '-')}</td>
        <td class="num">${escapeHtml(score(model.score))}</td>
        <td><span class="tag ${statusTone(model)}">${escapeHtml(model.status ?? 'unknown')}</span></td>
        <td class="num">${escapeHtml(fmt.num(model.telemetry?.liveFree ?? 0))}</td>
        <td class="num">${escapeHtml(fmt.num(model.contextLength ?? 0))}</td>
      </tr>`,
    )
    .join('');

  el('detailBody').innerHTML = `<div class="body">
    <h3>${escapeHtml(row.country)} <span class="oriso${row.mapped ? '' : ' unknown'}">${escapeHtml(row.iso)}</span></h3>
    <div class="sub">${row.mapped ? `${row.producers.length} producer lab(s) behind ${row.count} tracked model(s)` : 'no lab in the curated table claims this family'}</div>
    <div class="grid2">
      ${kv('models', fmt.num(row.count))}
      ${kv('share of page', fmt.pct(row.share))}
      ${kv('live models', fmt.num(row.live))}
      ${kv('avg score', score(row.avgScore))}
      ${kv('producers', fmt.num(row.producers.length))}
      ${kv('best model', row.top ? `${row.top.id} (${score(row.top.score)})` : '-')}
    </div>
    <h4>producers</h4>
    <table><thead><tr><th>organization</th><th>family slug</th><th class="num">models</th></tr></thead>
      <tbody>${producers || '<tr><td colspan="3">none</td></tr>'}</tbody></table>
    <h4>models</h4>
    <table><thead><tr><th>model</th><th class="num">rank</th><th class="num">score</th><th>status</th><th class="num">free providers</th><th class="num">context</th></tr></thead>
      <tbody>${models || '<tr><td colspan="6">none</td></tr>'}</tbody></table>
  </div>`;
  el('detail').showModal();
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function exportName(suffix) {
  const day = String(state.snapshot?.generatedAt ?? new Date().toISOString()).slice(0, 10);
  return `model-origins-${day}.${suffix}`;
}

function setPulse(mode) {
  el('pulse').className = `pulse ${mode}`;
}

function render() {
  state.rows = countriesOf(models());

  const summary = summarize(models());
  renderKpis();
  renderCountries();
  el('byCountry').innerHTML = countryChart(state.rows);
  el('byProducer').innerHTML = producerChart(state.rows);
  el('unmapped').innerHTML = unmappedList(state.rows);
  renderStatePanel();

  el('countriesMeta').textContent = state.snapshot
    ? `${fmt.num(summary.countries)} nation(s) \u00b7 ${fmt.num(summary.producers)} producer(s) \u00b7 ${fmt.num(summary.models)} models`
    : 'waiting for the first snapshot';
  el('updated').textContent = state.snapshot ? `updated ${fmt.time(state.snapshot.generatedAt)}` : 'connecting...';
  el('cycle').textContent = `cycle ${state.snapshot?.status?.cycles ?? 0}`;
  el('note').textContent = state.snapshot
    ? `built from the ${fmt.time(state.snapshot.generatedAt)} snapshot \u00b7 ${fmt.num(summary.models)} models grouped into ${fmt.num(summary.countries)} nation(s)`
    : '';
  setPulse(state.connected ? 'live' : 'stale');
}

el('search').addEventListener('input', (event) => {
  state.query = event.target.value;
  render();
});
el('sort').addEventListener('change', (event) => {
  state.sortKey = event.target.value;
  render();
});
el('onlyLive').addEventListener('change', (event) => {
  state.onlyLive = event.target.checked;
  render();
});
el('includeExtras').addEventListener('change', (event) => {
  state.includeExtras = event.target.checked;
  render();
});
el('exportCsv').addEventListener('click', () => {
  download(exportName('csv'), countriesCsvOf(state.rows, filters()), 'text/csv');
});
el('exportModels').addEventListener('click', () => {
  download(exportName('models.csv'), modelsCsvOf(state.rows, filters()), 'text/csv');
});
el('exportJson').addEventListener('click', () => {
  const meta = {
    generatedAt: state.snapshot?.generatedAt ?? null,
    cycle: state.snapshot?.status?.cycles ?? null,
    source: 'openrouter',
    basis: 'curated producer family -> nation table',
    includeExtras: state.includeExtras,
  };
  download(exportName('json'), jsonOf(visibleCountries(state.rows, filters()), meta), 'application/json');
});
el('countriesBody').addEventListener('click', (event) => {
  const head = event.target.closest('th[data-sort]');
  if (head) {
    if (state.sortKey === head.dataset.sort) state.sortDir *= -1;
    else {
      state.sortKey = head.dataset.sort;
      state.sortDir = defaultDirection(state.sortKey);
    }
    el('sort').value = state.sortKey;
    render();
    return;
  }
  const row = event.target.closest('tr[data-country]');
  if (row) openDetail(row.dataset.country);
});
el('detailClose').addEventListener('click', () => el('detail').close());

function connect() {
  const events = new EventSource('/api/events');

  events.addEventListener('open', () => {
    state.connected = true;
    setPulse('live');
  });
  events.addEventListener('snapshot', (event) => {
    state.snapshot = JSON.parse(event.data);
    state.connected = true;
    state.lastSnapshotAt = Date.now();
    render();
  });
  events.addEventListener('error', () => {
    state.connected = false;
    setPulse('stale');
  });
}

setInterval(() => {
  if (state.lastSnapshotAt && Date.now() - state.lastSnapshotAt > 150_000) setPulse('dead');
}, 10_000);

render();
connect();
