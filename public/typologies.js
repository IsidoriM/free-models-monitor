import {
  TABLE_LIMIT,
  defaultDirection,
  escapeHtml,
  extensionChart,
  filesCsvOf,
  folderChart,
  fmt,
  jsonOf,
  summarize,
  typologyChart,
  visibleTypologies,
} from './typologies-report.js';

const el = (id) => document.getElementById(id);

const state = {
  status: { state: 'idle', phase: null, filesSeen: 0, classified: 0 },
  result: null,
  query: '',
  sortKey: 'bytes',
  sortDir: -1,
  onlyUsed: false,
  connected: false,
  startedAt: 0,
  lastProgress: null,
};

function filters() {
  return { query: state.query, onlyUsed: state.onlyUsed, sortKey: state.sortKey, sortDir: state.sortDir };
}

function renderKpis() {
  const summary = summarize(state.result);
  const cards = [
    ['files', fmt.num(summary.files), '', ''],
    ['bytes', fmt.bytes(summary.bytes), '', 'every file the walk reached'],
    ['typologies', fmt.num(summary.typologies), '', 'buckets that hold at least one file'],
    ['extensions', fmt.num(summary.extensions), '', 'distinct trailing extensions'],
    ['folders', fmt.num(summary.folders), '', 'first folder below each scan root'],
    ['biggest', summary.biggest ? summary.biggest.label : '-', '', summary.biggest ? `${summary.biggest.label} holds the most bytes` : ''],
  ];
  el('kpis').innerHTML = cards
    .map(
      ([label, value, tone, title]) =>
        `<div class="stat ${tone}"${title ? ` title="${escapeHtml(title)}"` : ''}><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`,
    )
    .join('');

  el('roots').textContent = `roots ${(state.status.roots ?? []).join(', ') || '-'}`;
  el('typesMeta').textContent = state.result
    ? `${fmt.num(summary.typologies)} of the taxonomy in use \u00b7 ${fmt.bytes(summary.unknownBytes)} in other / no extension`
    : 'no scan yet';
}

function renderProgress() {
  const status = state.status ?? {};
  const box = el('progress');
  box.hidden = status.state !== 'scanning';
  if (box.hidden) return;

  const now = Date.now();
  const previous = state.lastProgress ?? { at: state.startedAt, seen: 0 };
  const seconds = Math.max(0.001, (now - previous.at) / 1000);
  const classifying = status.phase === 'classifying';
  const rate = Math.max(0, ((status.classified ?? 0) - previous.seen) / seconds);
  state.lastProgress = { at: now, seen: status.classified ?? 0 };

  el('progressPhase').textContent = classifying ? 'classifying files' : 'walking the tree';
  el('progressDetail').textContent = classifying
    ? `${fmt.num(status.classified)} classified \u00b7 ${fmt.num(status.skippedDirs)} skipped folders`
    : `${fmt.num(status.filesSeen)} files seen \u00b7 ${fmt.num(status.skippedDirs)} skipped folders`;
  el('progressRate').textContent = classifying ? `${fmt.num(Math.round(rate))} files/s` : 'reading names and sizes only';

  const bar = el('progressBar');
  bar.classList.toggle('indeterminate', !classifying);
  bar.style.width = classifying ? '100%' : '28%';
}

function renderScanPanel() {
  const status = state.status ?? {};
  const rows = [
    ['state', status.state],
    ['files walked', fmt.num(status.filesSeen)],
    ['files classified', fmt.num(status.classified)],
    ['scan duration', fmt.duration(status.durationMs)],
    ['typologies', fmt.num(state.result?.typologies?.length ?? 0)],
    ['unreadable', fmt.num(status.unreadable)],
  ];
  if (status.truncated) rows.push(['limit', 'stopped at the file cap']);
  if (status.error) rows.push(['error', status.error]);

  const kv = rows
    .map(([label, value]) => `<div class="kv"><span>${escapeHtml(label)}</span><span>${escapeHtml(String(value))}</span></div>`)
    .join('');
  const roots = (status.roots ?? []).map((root) => `<li title="${escapeHtml(root)}">${escapeHtml(root)}</li>`).join('');
  const note = state.result
    ? '<p class="note">the walk only reads the name and the size of a file: no content is opened, so the census stays cheap on a whole home folder.</p>'
    : '<p class="note">nothing scanned yet.</p>';

  el('scanPanel').innerHTML = `<div class="kvlist">${kv}</div><h3 class="subhead">roots</h3><ul class="ftlist">${roots}</ul>${note}`;
}

function chipList(entries, key) {
  if (!entries.length) return '<span class="hint">none</span>';
  return entries
    .slice(0, 4)
    .map((entry) => `<span class="tag" title="${escapeHtml(`${fmt.bytes(entry.bytes)} in ${fmt.num(entry.files)} file(s)`)}">${escapeHtml(entry[key])}</span>`)
    .join('');
}

function rowHtml(row, maxBytes, index) {
  const width = maxBytes > 0 ? Math.max(1.5, (row.bytes / maxBytes) * 100) : 0;
  const biggest = row.largest
    ? `<span class="ftpath" title="${escapeHtml(row.largest.path)}">${escapeHtml(row.largest.name)}</span>`
    : '-';
  return `<tr class="ft-group" data-typology="${escapeHtml(row.id)}" tabindex="0">
    <td class="num">${index + 1}</td>
    <td class="ftname">
      <div class="ddhead">
        <span class="ddname" title="${escapeHtml(row.hint)}">${escapeHtml(row.label)}</span>
        <span class="tag">${fmt.num(row.files)} file${row.files === 1 ? '' : 's'}</span>
      </div>
      <div class="ftexts">${chipList(row.extensions, 'ext')}</div>
      <ul class="ftfolders">${row.folders
        .slice(0, 3)
        .map((entry) => `<li title="${escapeHtml(`${fmt.bytes(entry.bytes)} in ${fmt.num(entry.files)} file(s)`)}">${escapeHtml(entry.folder)}</li>`)
        .join('')}</ul>
    </td>
    <td class="num ftwaste">
      <span class="ddbar"><span style="width:${width.toFixed(2)}%"></span></span>
      <b>${escapeHtml(fmt.bytes(row.bytes))}</b>
    </td>
    <td class="num">${escapeHtml(fmt.pct(row.share))}</td>
    <td class="num">${escapeHtml(fmt.bytes(row.largest?.size ?? 0))}</td>
    <td class="ftwhen" title="${escapeHtml(row.largest?.path ?? '')}">${escapeHtml(biggest)}</td>
    <td class="ftwhen">${escapeHtml(fmt.stamp(row.newest?.modifiedAt ?? null))}</td>
    <td class="ftwhen">${escapeHtml(fmt.stamp(row.oldest?.modifiedAt ?? null))}</td>
  </tr>`;
}

function renderTypologies() {
  const body = el('typesBody');
  const status = state.status ?? {};

  const bail = (message, bad = false) => {
    body.innerHTML = `<p class="empty${bad ? ' bad' : ''}">${message}</p>`;
  };

  if (status.state === 'unavailable') return bail('typology scanner disabled (TYPOLOGIES_ENABLED=false)');
  if (status.state === 'scanning') {
    const count = status.phase === 'classifying' ? status.classified : status.filesSeen;
    const unit = status.phase === 'classifying' ? 'files classified' : 'files seen';
    return bail(`${escapeHtml(status.phase ?? 'scanning')} &hellip; ${fmt.num(count)} ${unit}`);
  }
  if (status.state === 'error') return bail(`scan failed: ${escapeHtml(status.error ?? 'unknown error')}`, true);
  if (!state.result) {
    const roots = (status.roots ?? []).join(', ') || 'the configured roots';
    return bail(`no scan yet &mdash; press <b>scan</b> to classify ${escapeHtml(roots)}`);
  }

  const rows = visibleTypologies(state.result, filters());
  if (!rows.length) return bail('no typology matches the current filters');

  const shown = rows.slice(0, TABLE_LIMIT);
  const maxBytes = rows.reduce((max, row) => Math.max(max, row.bytes), 0);
  body.innerHTML = `<div class="tablewrap"><table class="fttable">
    <thead><tr>
      <th class="num">#</th>
      <th data-sort="label">typology</th>
      <th class="num" data-sort="bytes">bytes</th>
      <th class="num">share</th>
      <th class="num" data-sort="largest">biggest file</th>
      <th>largest path</th>
      <th data-sort="newest">newest</th>
      <th data-sort="oldest">oldest</th>
    </tr></thead>
    <tbody>${shown.map((row, index) => rowHtml(row, maxBytes, index)).join('')}</tbody>
  </table></div>${
    rows.length > shown.length ? `<p class="empty">showing the first ${fmt.num(shown.length)} of ${fmt.num(rows.length)} typologies</p>` : ''
  }`;
}

function biggestFiles() {
  const entries = visibleTypologies(state.result, { ...filters(), onlyUsed: true })
    .filter((row) => row.largest)
    .map((row) => ({ label: row.label, ...row.largest }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 8);
  if (!entries.length) {
    el('biggest').innerHTML = `<p class="empty">${state.result ? 'no files found' : 'run a scan first'}</p>`;
    return;
  }
  el('biggest').innerHTML = `<ul class="ftpaths">${entries
    .map(
      (entry) => `<li title="${escapeHtml(entry.path)}">
        <span class="barlabel" title="${escapeHtml(entry.label)}">${escapeHtml(entry.name)}</span>
        <span class="ftwhen">${escapeHtml(fmt.bytes(entry.size))}</span>
      </li>`,
    )
    .join('')}</ul>`;
}

function render() {
  const scanning = state.status?.state === 'scanning';

  renderKpis();
  renderProgress();
  renderScanPanel();
  el('byTypology').innerHTML = typologyChart(state.result);
  el('byExtension').innerHTML = extensionChart(state.result);
  el('byFolder').innerHTML = folderChart(state.result);
  biggestFiles();
  renderTypologies();

  el('scan').disabled = scanning || state.status?.state === 'unavailable';
  el('scan').textContent = scanning ? 'scanning...' : state.result ? 'rescan' : 'scan';
  el('cancel').disabled = !scanning;
  el('updated').textContent = state.result ? `scanned ${fmt.time(state.result.generatedAt)}` : scanning ? 'scanning...' : 'no scan yet';
  el('note').textContent = state.result
    ? `report built in ${fmt.duration(state.result.durationMs)} \u00b7 ${fmt.num(state.result.totals.files)} files \u00b7 ${fmt.num(state.result.totals.typologies)} typologies in use`
    : '';
  setPulse(state.connected ? 'live' : 'stale');
}

function setPulse(mode) {
  el('pulse').className = `pulse ${mode}`;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function openDetail(id) {
  const row = (state.result?.typologies ?? []).find((entry) => entry.id === id);
  if (!row) return;

  const kv = (label, value) => `<div class="kv"><span>${escapeHtml(label)}</span><span>${escapeHtml(String(value ?? '-'))}</span></div>`;
  const extensions = row.extensions
    .map((entry) => `<tr>
      <td>${escapeHtml(entry.ext)}</td>
      <td class="num">${fmt.num(entry.files)}</td>
      <td class="num">${escapeHtml(fmt.bytes(entry.bytes))}</td>
    </tr>`)
    .join('');
  const folders = row.folders
    .map(
      (entry) => `<tr>
        <td>${escapeHtml(entry.folder)}</td>
        <td class="num">${fmt.num(entry.files)}</td>
        <td class="num">${escapeHtml(fmt.bytes(entry.bytes))}</td>
      </tr>`,
    )
    .join('');

  el('detailBody').innerHTML = `<div class="body">
    <h3>${escapeHtml(row.label)}</h3>
    <div class="sub">${escapeHtml(row.hint)}</div>
    <div class="grid2">
      ${kv('files', fmt.num(row.files))}
      ${kv('bytes', fmt.bytes(row.bytes))}
      ${kv('share of scan', fmt.pct(row.share))}
      ${kv('distinct extensions', row.extensions.length)}
      ${kv('biggest file', row.largest ? `${row.largest.name} (${fmt.bytes(row.largest.size)})` : '-')}
      ${kv('newest file', row.newest ? `${row.newest.name} (${fmt.stamp(row.newest.modifiedAt)})` : '-')}
      ${kv('oldest file', row.oldest ? `${row.oldest.name} (${fmt.stamp(row.oldest.modifiedAt)})` : '-')}
      ${kv('folders', row.folders.length)}
    </div>
    ${row.largest ? `<h4>largest path</h4><p>${escapeHtml(row.largest.path)}</p>` : ''}
    <h4>extensions</h4>
    <table><thead><tr><th>extension</th><th class="num">files</th><th class="num">bytes</th></tr></thead>
      <tbody>${extensions || '<tr><td colspan="3">none</td></tr>'}</tbody></table>
    <h4>folders</h4>
    <table><thead><tr><th>folder</th><th class="num">files</th><th class="num">bytes</th></tr></thead>
      <tbody>${folders || '<tr><td colspan="3">none</td></tr>'}</tbody></table>
  </div>`;
  el('detail').showModal();
}

async function post(action) {
  try {
    const response = await fetch(`/api/typologies/${action}`, { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
    if (payload.status) state.status = payload.status;
    if (state.status?.state === 'scanning') {
      state.startedAt = Date.now();
      state.lastProgress = null;
    }
  } catch (error) {
    state.status = { ...state.status, state: 'error', error: error.message };
  }
  render();
}

el('scan').addEventListener('click', () => post('scan'));
el('cancel').addEventListener('click', () => post('cancel'));
el('search').addEventListener('input', (event) => {
  state.query = event.target.value;
  render();
});
el('sort').addEventListener('change', (event) => {
  state.sortKey = event.target.value;
  render();
});
el('onlyUsed').addEventListener('change', (event) => {
  state.onlyUsed = event.target.checked;
  render();
});
el('exportCsv').addEventListener('click', () => {
  if (state.result) download(`typologies-${state.result.generatedAt.slice(0, 10)}.csv`, filesCsvOf(state.result, filters()), 'text/csv');
});
el('exportJson').addEventListener('click', () => {
  if (state.result) download(`typologies-${state.result.generatedAt.slice(0, 10)}.json`, jsonOf(state.result, filters()), 'application/json');
});
el('typesBody').addEventListener('click', (event) => {
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
  const row = event.target.closest('tr[data-typology]');
  if (row) openDetail(row.dataset.typology);
});
el('detailClose').addEventListener('click', () => el('detail').close());

function connect() {
  const events = new EventSource('/api/events');

  events.addEventListener('open', () => {
    state.connected = true;
    render();
  });
  events.addEventListener('typologies', (event) => {
    const payload = JSON.parse(event.data);
    const wasScanning = state.status?.state === 'scanning';

    state.status = payload.status ?? state.status;
    state.result = payload.result ?? null;
    if (state.status.state === 'scanning' && !wasScanning) {
      state.startedAt = Date.now();
      state.lastProgress = null;
    }
    render();
  });
  events.addEventListener('error', () => {
    state.connected = false;
    setPulse('stale');
  });
}

setInterval(renderProgress, 500);
render();
connect();