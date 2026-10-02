/**
 * Pure reporting layer for the FileTypologies page.
 *
 * Everything here works on the payload the scanner already produced (see
 * src/core/typologies.js) and turns it into the numbers, buckets and rows the
 * page renders. No DOM access, so the browser module and the tests can share it.
 */

import { escapeHtml, fmt } from './format.js';

export { escapeHtml, fmt };

export const TABLE_LIMIT = 30;

export const SORT_KEYS = ['bytes', 'files', 'label', 'newest', 'oldest', 'largest'];

/** Sorts that read better A->Z, so their direction is never flipped. */
const TEXT_SORTS = new Set(['label']);

const collator = new Intl.Collator(undefined, { numeric: true });

export function compareTypologies(a, b, key) {
  if (key === 'files') return a.files - b.files;
  if (key === 'newest') return collator.compare(a.newest?.modifiedAt ?? '', b.newest?.modifiedAt ?? '');
  if (key === 'oldest') return collator.compare(a.oldest?.modifiedAt ?? '', b.oldest?.modifiedAt ?? '');
  if (key === 'largest') return (a.largest?.size ?? 0) - (b.largest?.size ?? 0);
  return collator.compare(a.label, b.label);
}

export function defaultDirection(key) {
  return TEXT_SORTS.has(key) ? 1 : -1;
}

/** Headline numbers for the KPI row, all derived from the one payload. */
export function summarize(result) {
  const typologies = result?.typologies ?? [];
  const used = typologies.filter((row) => row.files > 0);
  const biggest = used.reduce((best, row) => (row.bytes > (best?.bytes ?? 0) ? row : best), null);
  return {
    files: result?.totals.files ?? 0,
    bytes: result?.totals.bytes ?? 0,
    typologies: used.length,
    extensions: result?.totals.extensions ?? 0,
    folders: result?.totals.folders ?? 0,
    biggest,
    unknownFiles: result?.totals.unknownFiles ?? 0,
    unknownBytes: result?.totals.unknownBytes ?? 0,
  };
}

/** Filters and orders the typology rows for the table; never mutates `result`. */
export function visibleTypologies(result, { query = '', onlyUsed = false, sortKey = 'bytes', sortDir = -1 } = {}) {
  const needle = query.trim().toLowerCase();
  const rows = (result?.typologies ?? []).filter((row) => {
    if (onlyUsed && row.files === 0) return false;
    if (!needle) return true;
    if (row.label.toLowerCase().includes(needle)) return true;
    if (row.hint.toLowerCase().includes(needle)) return true;
    return row.extensions.some((entry) => entry.ext.toLowerCase().includes(needle));
  });

  const dir = TEXT_SORTS.has(sortKey) ? 1 : sortDir;
  return [...rows].sort((a, b) => {
    const primary = compareTypologies(a, b, sortKey) * dir;
    return primary || collator.compare(a.label, b.label);
  });
}

/** The heaviest keys of one map, for the side charts. */
export function topEntries(entries, key, limit = 12) {
  const all = [...(entries ?? [])].sort((a, b) => b.bytes - a.bytes || collator.compare(a[key], b[key]));
  return all.slice(0, limit);
}

function chartHtml(entries, key, empty) {
  if (!entries.length) return `<p class="empty">${escapeHtml(empty ?? 'nothing to chart')}</p>`;
  const max = entries.reduce((best, entry) => Math.max(best, entry.bytes), 0) || 1;
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0) || 1;
  return `<ul class="bars cool">${entries
    .map(
      (entry) => `<li title="${escapeHtml(`${entry[key]}: ${fmt.bytes(entry.bytes)} in ${fmt.num(entry.files)} file(s)`)}">
        <span class="barlabel">${escapeHtml(entry[key])}</span>
        <span class="bartrack"><span class="barfill" style="width:${((entry.bytes / max) * 100).toFixed(2)}%"></span></span>
        <span class="barvalue">${escapeHtml(fmt.bytes(entry.bytes))}<em>${((entry.bytes / total) * 100).toFixed(0)}%</em></span>
      </li>`,
    )
    .join('')}</ul>`;
}

/** Bytes per typology, the headline chart of the page. */
export function typologyChart(result) {
  const entries = (result?.typologies ?? [])
    .filter((row) => row.bytes > 0)
    .map((row) => ({ label: row.label, id: row.id, files: row.files, bytes: row.bytes }));
  return chartHtml(entries, 'label', result ? 'no files found' : 'run a scan first');
}

/** Bytes per extension, across every typology. */
export function extensionChart(result) {
  return chartHtml(topEntries(result?.topExtensions, 'ext'), 'ext', result ? 'no extensions found' : 'run a scan first');
}

/** Bytes per folder below the deepest scan root, across every typology. */
export function folderChart(result) {
  return chartHtml(topEntries(result?.topFolders, 'folder'), 'folder', result ? 'no folders found' : 'run a scan first');
}

/** One row per file, the finest grain the report can hand to a spreadsheet. */
export function filesCsvOf(result, filters = {}) {
  const rows = visibleTypologies(result, filters);
  const lines = ['typology,files,bytes,share,largest_file,largest_path,newest,oldest,top_extensions'];
  for (const row of rows) {
    const cells = [
      row.label,
      row.files,
      row.bytes,
      row.share.toFixed(4),
      row.largest?.name ?? '',
      row.largest?.path ?? '',
      row.newest?.modifiedAt ?? '',
      row.oldest?.modifiedAt ?? '',
      row.extensions.map((entry) => `${entry.ext} (${entry.files})`).join(' | '),
    ];
    lines.push(cells.map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function jsonOf(result, filters = {}) {
  const rows = visibleTypologies(result, filters).map((row) => ({
    id: row.id,
    label: row.label,
    files: row.files,
    bytes: row.bytes,
    share: Number(row.share.toFixed(4)),
    extensions: row.extensions,
    folders: row.folders,
    largest: row.largest,
    newest: row.newest,
    oldest: row.oldest,
  }));
  return `${JSON.stringify({ generatedAt: result?.generatedAt ?? null, roots: result?.roots ?? [], totals: result?.totals ?? null, typologies: rows }, null, 2)}\n`;
}

const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};