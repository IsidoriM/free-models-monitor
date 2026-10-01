import process from 'node:process';
import { config } from './config.js';
import { Monitor } from './core/monitor.js';
import { createOpenRouterSource } from './sources/openrouter.js';

const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
};

const c = (color, text) => (process.stdout.isTTY ? `${ANSI[color]}${text}${ANSI.reset}` : text);

const pad = (value, width, align = 'left') => {
  const text = String(value ?? '');
  if (text.length >= width) return text.slice(0, width);
  const filler = ' '.repeat(width - text.length);
  return align === 'right' ? filler + text : text + filler;
};

const uptimeCell = (value) => {
  if (value === null || value === undefined) return c(ANSI.gray, '   n/a');
  const color = value >= 99 ? ANSI.green : value >= 95 ? ANSI.yellow : ANSI.red;
  return c(color, `${value.toFixed(1).padStart(6)}%`);
};

const deltaCell = (delta) => {
  if (delta === null || delta === undefined) return c(ANSI.cyan, ' NEW');
  if (delta === 0) return c(ANSI.gray, '  -');
  return delta > 0 ? c(ANSI.green, ` +${delta}`) : c(ANSI.red, ` ${delta}`);
};

const STATUS_LABEL = { live: c(ANSI.green, 'live'), unavailable: c(ANSI.red, 'down'), expired: c(ANSI.gray, 'expd') };

function render(snapshot, status) {
  const lines = [];
  const width = 118;
  lines.push(c(ANSI.bold, 'free-models-monitor') + c(ANSI.gray, `  top ${snapshot.counts.tracked} free models`));
  lines.push(
    c(ANSI.gray, `updated ${snapshot.generatedAt ?? '-'} | poll ${status.pollIntervalMs / 1000}s | ` +
      `cycle ${status.cycles} | next ${status.nextRunAt ?? '-'} | probes ${status.probeEnabled ? 'on' : 'off'}`),
  );
  if (status.lastError) lines.push(c(ANSI.red, `last error: ${status.lastError.message}`));
  if (snapshot.failures?.length) {
    lines.push(c(ANSI.yellow, `endpoint failures: ${snapshot.failures.map((f) => `${f.id} (${f.status ?? 'net'})`).join(', ')}`));
  }
  lines.push('');

  const header = [
    c(ANSI.gray, pad('#', 3)),
    c(ANSI.gray, pad('MODEL', 34)),
    c(ANSI.gray, pad('UP5M', 8, 'right')),
    c(ANSI.gray, pad('LAT', 7, 'right')),
    c(ANSI.gray, pad('CTX', 10, 'right')),
    c(ANSI.gray, pad('PROV', 5, 'right')),
    c(ANSI.gray, pad('SCORE', 6, 'right')),
    c(ANSI.gray, pad('STATUS', 8)),
    c(ANSI.gray, pad('D', 5, 'right')),
  ].join(' ');
  lines.push(header);
  lines.push(c(ANSI.gray, '-'.repeat(width)));

  if (!snapshot.models.length) {
    lines.push(c(ANSI.yellow, ' waiting for the first poll to finish...'));
  }

  for (const model of snapshot.models) {
    lines.push(
      [
        pad(model.rank, 3),
        pad(model.id, 34),
        uptimeCell(model.telemetry.bestUptime5m),
        pad(model.telemetry.bestLatencyMs === null ? 'n/a' : `${model.telemetry.bestLatencyMs}ms`, 7, 'right'),
        pad(model.contextLength ? `${Math.round(model.contextLength / 1000)}k` : '-', 10, 'right'),
        pad(model.telemetry.liveFree, 5, 'right'),
        pad(model.score.toFixed(1), 6, 'right'),
        pad(STATUS_LABEL[model.status] ?? model.status, 8),
        deltaCell(model.rankDelta),
      ].join(' '),
    );
  }

  const extras = snapshot.extras ?? [];
  if (extras.length) {
    lines.push('');
    lines.push(c(ANSI.gray, `also free (${extras.length} outside the top ${config.topN}):`));
    lines.push(
      c(
        ANSI.gray,
        extras.map((model) => `${model.id} ${model.score.toFixed(1)}`).join('  |  '),
      ),
    );
  }

  return lines.join('\n');
}

const source = createOpenRouterSource(config);
const monitor = new Monitor({ source, config });

const draw = () => {
  process.stdout.write('\u001b[2J\u001b[H');
  process.stdout.write(`${render(monitor.store.getState(), monitor.getStatus())}\n`);
};

monitor.on('snapshot', draw);
monitor.on('changes', (changes) => {
  for (const change of changes.slice(0, 5)) {
    const label = change.type === 'rank-up' ? '\u001b[32m\u25b2' : change.type === 'rank-down' ? '\u001b[31m\u25bc' : '\u001b[36m\u2022';
    process.stderr.write(`${label}${ANSI.reset} ${change.modelName ?? change.modelId} ${change.type} ${change.to ?? change.from ?? ''}\n`);
  }
});

process.on('SIGINT', () => {
  monitor.stop();
  process.stdout.write('\nstopped.\n');
  process.exit(0);
});

console.log('starting poll, this takes a few seconds...');
await monitor.start();
draw();