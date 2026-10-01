import { config } from './config.js';
import { DuplicateScanner } from './core/duplicates.js';
import { Monitor } from './core/monitor.js';
import { createServer } from './core/server.js';
import { createOpenRouterSource } from './sources/openrouter.js';

const source = createOpenRouterSource(config);
const monitor = new Monitor({ source, config });
const duplicates = config.duplicates.enabled ? new DuplicateScanner({ config: config.duplicates }) : null;
const { server } = createServer({ monitor, config, duplicates });

let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down.`);
  monitor.stop();
  duplicates?.cancel();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => console.error('unhandled rejection:', error));

try {
  await monitor.start();
} catch (error) {
  console.error(`initial poll failed: ${error.message}`);
  process.exit(1);
}

server.listen(config.port, config.host, () => {
  const first = monitor.store.getState();
  console.log(`free-models-monitor -> http://${config.host}:${config.port}`);
  console.log(
    `polling every ${config.pollIntervalMs / 1000}s | top ${config.topN} free models | ` +
      `${first.counts.live} live / ${first.counts.tracked} tracked | ` +
      `probes ${config.probe.enabled ? 'on' : 'off'}`,
  );
  if (first.failures.length) console.log(`endpoint fetch failures: ${first.failures.length}`);
  if (duplicates) console.log(`duplicate scanner ready over ${duplicates.getStatus().roots.join(', ')}`);
});
