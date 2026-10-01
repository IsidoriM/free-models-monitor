import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { DuplicateScanner } from '../src/core/duplicates.js';

const silentLogger = { warn() {}, error() {} };
const tempDirs = [];

async function makeTree(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dupes-test-'));
  tempDirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

const configFor = (root, overrides = {}) => ({
  roots: [root],
  exclude: ['node_modules', 'AppData', '.git'],
  minSizeBytes: 1,
  maxFileBytes: 0,
  maxFiles: 10_000,
  maxDepth: 12,
  concurrency: 4,
  topGroups: 100,
  ...overrides,
});

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('DuplicateScanner', () => {
  it('reports identical files that live in different folders', async () => {
    const root = await makeTree({
      'a/report.txt': 'hello world',
      'b/report.txt': 'hello world',
      'b/readme.md': 'something else entirely',
    });

    const scanner = new DuplicateScanner({ config: configFor(root), logger: silentLogger });
    const result = await scanner.scan();

    assert.equal(result.groups.length, 1);
    const [group] = result.groups;
    assert.equal(group.count, 2);
    assert.equal(group.size, 11);
    assert.equal(group.wasted, 11);
    assert.deepEqual(
      group.paths.map((file) => path.relative(root, file.path).replaceAll('\\', '/')).sort(),
      ['a/report.txt', 'b/report.txt'],
    );
  });

  it('does not group files that share a size but differ in content', async () => {
    const root = await makeTree({
      'x/one.bin': 'aaaa',
      'y/two.bin': 'bbbb',
    });

    const scanner = new DuplicateScanner({ config: configFor(root), logger: silentLogger });
    const result = await scanner.scan();

    assert.deepEqual(result.groups, []);
    assert.equal(result.totals.wastedBytes, 0);
  });

  it('splits same-content groups of different sizes', async () => {
    const root = await makeTree({
      'small/a.txt': 'same content',
      'small/b.txt': 'same content',
      'small/longer.txt': 'same content plus a tail',
      'small/longer-copy.txt': 'same content plus a tail',
    });

    const scanner = new DuplicateScanner({ config: configFor(root), logger: silentLogger });
    const result = await scanner.scan();

    assert.equal(result.groups.length, 2);
    const sizes = result.groups.map((group) => group.size).sort((a, b) => a - b);
    assert.deepEqual(sizes, [12, 24]);
  });

  it('hashes files larger than one read chunk in a single pass', async () => {
    const payload = randomBytes(2_500_000);
    const root = await makeTree({
      'big/one.bin': payload,
      'big/two.bin': payload,
    });

    const scanner = new DuplicateScanner({ config: configFor(root), logger: silentLogger });
    const result = await scanner.scan();

    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].size, 2_500_000);
    assert.equal(result.groups[0].count, 2);
    assert.match(result.groups[0].hash, /^[0-9a-f]{64}$/);
  });

  it('ignores files below minSizeBytes', async () => {
    const root = await makeTree({ 'a/tiny.txt': 'ab', 'b/tiny.txt': 'ab' });

    const scanner = new DuplicateScanner({ config: configFor(root, { minSizeBytes: 10 }), logger: silentLogger });
    const result = await scanner.scan();

    assert.deepEqual(result.groups, []);
    assert.equal(scanner.getStatus().filesSeen, 0);
  });

  it('ignores files above maxFileBytes when the cap is set', async () => {
    const root = await makeTree({ 'a/huge.bin': 'x'.repeat(5000), 'b/huge.bin': 'x'.repeat(5000) });

    const scanner = new DuplicateScanner({ config: configFor(root, { maxFileBytes: 1000 }), logger: silentLogger });
    const result = await scanner.scan();

    assert.deepEqual(result.groups, []);
  });

  it('skips excluded directory names', async () => {
    const root = await makeTree({
      'keep/file.txt': 'duplicate me',
      'keep/copy.txt': 'duplicate me',
      'node_modules/file.txt': 'duplicate me',
      'node_modules/copy.txt': 'duplicate me',
      '.git/file.txt': 'duplicate me',
      '.git/copy.txt': 'duplicate me',
    });

    const scanner = new DuplicateScanner({ config: configFor(root), logger: silentLogger });
    const result = await scanner.scan();

    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].count, 2);
    assert.equal(
      result.groups[0].paths.every((file) => !file.path.includes('node_modules')),
      true,
    );
  });

  it('stops descending past maxDepth', async () => {
    const root = await makeTree({
      'shallow-a.txt': 'reached',
      'shallow-b.txt': 'reached',
      'a/b/c/deep-a.txt': 'unreached',
      'a/b/c/deep-b.txt': 'unreached',
    });

    const scanner = new DuplicateScanner({ config: configFor(root, { maxDepth: 2 }), logger: silentLogger });
    const result = await scanner.scan();

    assert.equal(result.groups.length, 1);
    assert.deepEqual(
      result.groups[0].paths.map((file) => path.relative(root, file.path).replaceAll('\\', '/')).sort(),
      ['shallow-a.txt', 'shallow-b.txt'],
    );
  });

  it('sorts groups by recoverable bytes descending', async () => {
    const root = await makeTree({
      'small/a.bin': 'aaaa',
      'small/b.bin': 'aaaa',
      'big/a.bin': 'b'.repeat(900),
      'big/b.bin': 'b'.repeat(900),
      'big/c.bin': 'b'.repeat(900),
    });

    const scanner = new DuplicateScanner({ config: configFor(root), logger: silentLogger });
    const result = await scanner.scan();

    assert.equal(result.groups.length, 2);
    assert.deepEqual(result.groups.map((group) => group.wasted), [1800, 4]);
    assert.equal(result.totals.duplicateFiles, 5);
    assert.equal(result.totals.wastedFiles, 3);
    assert.equal(result.totals.wastedBytes, 1804);
  });

  it('caps the reported groups and flags the truncation', async () => {
    const root = await makeTree({
      'a/one.bin': 'aaaa',
      'a/two.bin': 'aaaa',
      'a/three.bin': 'aaaa',
      'b/four.bin': 'bbbb',
      'b/five.bin': 'bbbb',
      'b/six.bin': 'bbbb',
    });

    const scanner = new DuplicateScanner({ config: configFor(root, { topGroups: 1 }), logger: silentLogger });
    const result = await scanner.scan();

    assert.equal(result.groups.length, 1);
    assert.equal(result.groupsShown, 1);
    assert.equal(result.groupsTruncated, true);
    assert.equal(result.totals.groups, 2);
  });

  it('merges groups that span several roots', async () => {
    const first = await makeTree({ 'one/a.txt': 'shared bytes' });
    const second = await makeTree({ 'two/b.txt': 'shared bytes' });

    const scanner = new DuplicateScanner({
      config: configFor(first, { roots: [first, second] }),
      logger: silentLogger,
    });
    const result = await scanner.scan();

    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].count, 2);
    assert.deepEqual(result.roots, [first, second]);
  });

  it('survives unreadable roots and reports them as unreadable', async () => {
    const root = await makeTree({ 'a.txt': 'content', 'b.txt': 'content' });
    const missing = path.join(root, 'does-not-exist');
    const scanner = new DuplicateScanner({
      config: configFor(root, { roots: [missing, root] }),
      logger: silentLogger,
    });
    const result = await scanner.scan();

    assert.equal(scanner.getStatus().unreadable, 1);
    assert.equal(result.groups.length, 1);
  });

  it('marks the file cap and keeps walking bounded', async () => {
    const root = await makeTree({ 'a/one.txt': 'aaaa', 'a/two.txt': 'aaaa', 'a/three.txt': 'aaaa' });

    const scanner = new DuplicateScanner({ config: configFor(root, { maxFiles: 1_000, minSizeBytes: 1 }), logger: silentLogger });
    await scanner.scan();
    assert.equal(scanner.getStatus().truncated, false);
  });

  it('ignores symlinks so directory cycles cannot trap the walk', async () => {
    const root = await makeTree({ 'a/real.txt': 'target content' });
    try {
      await symlink(root, path.join(root, 'a', 'loop'), 'junction');
    } catch {
      return; // symlink creation needs elevation on Windows
    }

    const scanner = new DuplicateScanner({ config: configFor(root), logger: silentLogger });
    const result = await scanner.scan();

    assert.deepEqual(result.groups, []);
    assert.equal(scanner.getStatus().filesSeen, 1);
  });

  it('reports scan state through the status snapshot', async () => {
    const root = await makeTree({ 'a.txt': 'one', 'b.txt': 'one' });
    const scanner = new DuplicateScanner({ config: configFor(root), logger: silentLogger });

    assert.equal(scanner.getStatus().state, 'idle');
    assert.equal(scanner.isRunning(), false);
    assert.deepEqual(scanner.snapshot().result, null);

    const updates = [];
    scanner.on('update', (payload) => updates.push(payload.status.state));
    await scanner.scan();

    const status = scanner.getStatus();
    assert.equal(status.state, 'done');
    assert.equal(status.phase, null);
    assert.equal(status.durationMs >= 0, true);
    assert.equal(status.candidatesHashed, 2);
    assert.equal(scanner.isRunning(), false);
    assert.ok(updates.includes('scanning'));
    assert.ok(updates.includes('done'));
  });

  it('rejects a second scan while one is in flight', async () => {
    const root = await makeTree({ 'a.txt': 'one', 'b.txt': 'one' });
    const scanner = new DuplicateScanner({ config: configFor(root), logger: silentLogger });

    const first = scanner.scan();
    assert.equal(scanner.isRunning(), true);
    await assert.rejects(scanner.scan(), /already running/);
    await assert.rejects(async () => scanner.start(), /already running/);
    await first;
    assert.equal(scanner.isRunning(), false);
  });

  it('never writes to or removes anything under the scanned roots', async () => {
    const root = await makeTree({ 'a/one.txt': 'same', 'a/two.txt': 'same' });
    const before = new Map();
    const { readdir, stat } = await import('node:fs/promises');
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else before.set(full, (await stat(full)).size);
      }
    };
    await walk(root);

    const scanner = new DuplicateScanner({ config: configFor(root), logger: silentLogger });
    await scanner.scan();

    const after = new Map();
    const walkAfter = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walkAfter(full);
        else after.set(full, (await stat(full)).size);
      }
    };
    await walkAfter(root);

    assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
  });
});
