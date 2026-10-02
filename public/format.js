/**
 * Formatting helpers shared by the dashboards.
 *
 * Kept in their own module so every page renders numbers and escapes text the
 * same way, without any of them importing another page's report layer.
 */

export const fmt = {
  num: (value) => (typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '-'),
  bytes: (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let amount = value / 1024;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024;
      unit += 1;
    }
    return `${amount < 10 ? amount.toFixed(2) : amount.toFixed(1)} ${units[unit]}`;
  },
  pct: (value, digits = 1) => (typeof value !== 'number' || !Number.isFinite(value) ? 'n/a' : `${(value * 100).toFixed(digits)}%`),
  time: (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) : '-'),
  stamp: (iso) => (iso ? String(iso).slice(0, 19).replace('T', ' ') : '-'),
  duration: (ms) => {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '-';
    if (ms < 1000) return `${ms} ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    return `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
  },
};

export const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);