import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  classifyFile,
  extensionOf,
  folderOf,
  TYPOLOGIES,
  TypologyScanner,
  UNKNOWN_TYPOLOGY,
  typologyById,
} from '../src/core/typologies.js';

const silentLogger = { warn() {}, error() {} };
const tempDirs = [];

async function makeTree(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'typologies-test-'));
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
  minSizeBytes: 0,
  maxFileBytes: 0,
  maxFiles: 10_000,
  maxDepth: 12,
  concurrency: 4,
  topExtensions: 10,
  topFolders: 10,
  ...overrides,
});

const rowFor = (result, id) => result.typologies.find((row) => row.id === id);

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('extensionOf', () => {
  it('lowercases the trailing extension', () => {
    assert.equal(extensionOf('Movie.MKV'), '.mkv');
    assert.equal(extensionOf('archive.tar.gz'), '.gz');
  });

  it('reads only the last path segment', () => {
    assert.equal(extensionOf('C:\\Users\\me\\notes.TXT'), '.txt');
  });

  it('reports a placeholder when there is no extension', () => {
    assert.equal(extensionOf('README'), '(none)');
    assert.equal(extensionOf(''), '(none)');
  });
});

describe('the taxonomy', () => {
  it('never lists the same extension twice', () => {
    const seen = new Map();
    for (const typology of TYPOLOGIES) {
      for (const ext of typology.extensions) {
        assert.equal(ext, ext.toLowerCase(), `${ext} must be lowercase`);
        assert.ok(!seen.has(ext), `${ext} is claimed by ${seen.get(ext)} and ${typology.id}`);
        seen.set(ext, typology.id);
      }
    }
  });

  it('only uses extensions the scanner can actually see', () => {
    for (const typology of TYPOLOGIES) {
      for (const ext of typology.extensions) {
        assert.equal(extensionOf(`sample${ext}`), ext, `${ext} is unreachable: only the trailing extension is read`);
      }
    }
  });

  it('resolves every id and falls back to the unknown bucket', () => {
    for (const typology of TYPOLOGIES) assert.equal(typologyById(typology.id), typology);
    assert.equal(typologyById('nope'), UNKNOWN_TYPOLOGY);
    assert.equal(typologyById(undefined), UNKNOWN_TYPOLOGY);
  });
});

describe('classifyFile', () => {
  it('buckets a file by its trailing extension', () => {
    assert.deepEqual(classifyFile({ name: 'holiday.JPG' }), { typology: 'images', ext: '.jpg', known: true });
    assert.deepEqual(classifyFile({ name: 'main.rs' }), { typology: 'code', ext: '.rs', known: true });
  });

  it('derives the extension from the path when the name is missing', () => {
    assert.equal(classifyFile({ path: 'C:\\tmp\\notes.md' }).typology, 'documents');
  });

  it('flags an extension outside the taxonomy as unknown', () => {
    assert.deepEqual(classifyFile({ name: 'strange.qqq' }), { typology: 'unknown', ext: '.qqq', known: false });
    assert.deepEqual(classifyFile({ name: 'Makefile' }), { typology: 'unknown', ext: '(none)', known: false });
  });
});

describe('folderOf', () => {
  const root = 'C:\\Users\\test\\Documents';

  it('buckets by the first folder below the root', () => {
    assert.equal(folderOf('C:\\Users\\test\\Documents\\media\\clips\\a.mp4', [root]), 'media');
  });

  it('prefers the deepest root that matches', () => {
    assert.equal(folderOf('C:\\Users\\test\\Documents\\media\\a.mp4', [root, `${root}\\media`]), '<media>');
  });

  it('labels paths outside every root', () => {
    assert.equal(folderOf('C:\\Windows\\a.dll', [root]), '(outside roots)');
    assert.equal(folderOf('C:\\Users\\test\\Documents\\a.dll', []), '(outside roots)');
  });
});

describe('TypologyScanner', () => {
  it('groups files by typology with counts and bytes', async () => {
    const root = await makeTree({
      'docs/notes.txt': 'a'.repeat(100),
      'docs/report.pdf': 'b'.repeat(900),
      'media/clip.mp4': 'c'.repeat(4_000),
      'media/theme.mp3': 'd'.repeat(1_000),
    });

    const scanner = new TypologyScanner({ config: configFor(root), logger: silentLogger });
    const result = await scanner.scan();

    assert.equal(result.totals.files, 4);
    assert.equal(result.totals.bytes, 6_000);
    assert.equal(rowFor(result, 'documents').files, 2);
    assert.equal(rowFor(result, 'documents').bytes, 1_000);
    assert.equal(rowFor(result, 'video').files, 1);
    assert.equal(rowFor(result, 'video').bytes, 4_000);
    assert.equal(rowFor(result, 'audio').bytes, 1_000);
  });

  it('sorts typologies by bytes and reports the share of the scan', async () => {
    const root = await makeTree({ 'a/one.mp4': 'x'.repeat(3_000), 'b/two.txt': 'y'.repeat(1_000) });

    const scanner = new TypologyScanner({ config: configFor(root), logger: silentLogger });
    const result = await scanner.scan();

    assert.equal(result.typologies[0].id, 'video');
    assert.equal(result.typologies[1].id, 'documents');
    assert.equal(rowFor(result, 'video').share, 0.75);
    assert.equal(rowFor(result, 'documents').share, 0.25);
    assert.equal(result.totals.typologies, 2);
  });

  it('lists the heaviest extensions and folders of each typology', async () => {
    const root = await makeTree({
      'docs/a.txt': 'x'.repeat(10),
      'docs/b.txt': 'x'.repeat(900),
      'docs/c.md': 'x'.repeat(50),
      'code/main.js': 'x'.repeat(700),
    });

    const scanner = new TypologyScanner({ config: configFor(root), logger: silentLogger });
    const result = await scanner.scan();

    assert.deepEqual(rowFor(result, 'documents').extensions, [
      { ext: '.txt', files: 2, bytes: 910 },
      { ext: '.md', files: 1, bytes: 50 },
    ]);
    assert.deepEqual(rowFor(result, 'code').extensions, [{ ext: '.js', files: 1, bytes: 700 }]);
    assert.deepEqual(result.topFolders, [
      { folder: 'docs', files: 3, bytes: 960 },
      { folder: 'code', files: 1, bytes: 700 },
    ]);
  });

  it('keeps the largest, newest and oldest file of every typology', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'typologies-age-'));
    tempDirs.push(root);
    const write = async (name, size, modifiedAt) => {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'x'.repeat(size));
      const seconds = Date.parse(modifiedAt) / 1000;
      await utimes(target, seconds, seconds);
    };
    await write('media/old.mp4', 100, '2020-01-01T00:00:00.000Z');
    await write('media/new.mp4', 300, '2025-06-01T00:00:00.000Z');
    await write('media/mid.mp4', 200, '2023-01-01T00:00:00.000Z');

    const scanner = new TypologyScanner({ config: configFor(root), logger: silentLogger });
    const result = await scanner.scan();
    const video = rowFor(result, 'video');

    assert.equal(video.largest.name, 'new.mp4');
    assert.equal(video.newest.name, 'new.mp4');
    assert.equal(video.oldest.name, 'old.mp4');
    assert.equal(result.newestFile.name, 'new.mp4');
    assert.equal(result.oldestFile.name, 'old.mp4');
  });

  it('counts empty files, because a census wants every placeholder', async () => {
    const root = await makeTree({ 'logs/app.log': '', 'notes.txt': '' });

    const scanner = new TypologyScanner({ config: configFor(root), logger: silentLogger });
    const result = await scanner.scan();

    assert.equal(result.totals.files, 2);
    assert.equal(result.totals.bytes, 0);
    assert.equal(rowFor(result, 'temporary').files, 1);
    assert.equal(result.totals.typologies, 2);
  });

  it('files unknown extensions in their own bucket and keeps the taxonomy complete', async () => {
    const root = await makeTree({ 'a/blob.qqq': 'x'.repeat(10), 'b/plain': 'x'.repeat(5) });

    const scanner = new TypologyScanner({ config: configFor(root), logger: silentLogger });
    const result = await scanner.scan();

    assert.equal(rowFor(result, UNKNOWN_TYPOLOGY.id).files, 2);
    assert.equal(rowFor(result, UNKNOWN_TYPOLOGY.id).bytes, 15);
    assert.equal(result.totals.unknownFiles, 2);
    assert.equal(result.totals.unknownBytes, 15);
    assert.equal(result.typologies.length, TYPOLOGIES.length + 1);
    assert.equal(result.totals.typologies, 1);
  });

  it('skips the excluded folders', async () => {
    const root = await makeTree({
      'keep/notes.txt': 'x',
      'node_modules/pkg/index.js': 'x',
      '.git/config': 'x',
    });

    const scanner = new TypologyScanner({ config: configFor(root), logger: silentLogger });
    const result = await scanner.scan();

    assert.equal(result.totals.files, 1);
    assert.equal(rowFor(result, 'documents').files, 1);
    assert.equal(rowFor(result, 'code').files, 0);
  });

  it('stops at the file cap and says so', async () => {
    const root = await makeTree({ 'a/one.txt': 'x', 'b/two.txt': 'x', 'c/three.txt': 'x' });

    const scanner = new TypologyScanner({ config: configFor(root, { maxFiles: 1 }), logger: silentLogger });
    const result = await scanner.scan();

    assert.equal(result.totals.files, 1);
    assert.equal(scanner.getStatus().truncated, true);
  });

  it('does not descend past the depth limit', async () => {
    const root = await makeTree({ 'a/one.txt': 'x', 'a/deeper/two.txt': 'x' });

    const scanner = new TypologyScanner({ config: configFor(root, { maxDepth: 1 }), logger: silentLogger });
    const result = await scanner.scan();

    // maxDepth 1 reaches the folders under the root but never their own content.
    assert.equal(result.totals.files, 0);
    assert.equal(scanner.getStatus().skippedDirs, 1);
  });

  it('cancels mid-scan and reports it in the status', async () => {
    const root = await makeTree({ 'a/one.txt': 'x'.repeat(50) });

    const scanner = new TypologyScanner({ config: configFor(root), logger: silentLogger });
    const updates = [];
    scanner.on('update', (payload) => updates.push(payload.status.state));

    const scan = scanner.scan();
    scanner.cancel();
    await scan;

    assert.ok(updates.includes('scanning'));
    assert.equal(scanner.getStatus().state, 'cancelled');
    assert.equal(scanner.getResult(), null);
  });

  it('rejects a second scan while one is running', async () => {
    const root = await makeTree({ 'a/one.txt': 'x'.repeat(50) });
    const scanner = new TypologyScanner({ config: configFor(root), logger: silentLogger });

    const scan = scanner.scan();
    await assert.rejects(async () => scanner.start(), /already running/);
    await scan;
  });

  it('reports a scan failure without throwing', async () => {
    const root = await makeTree({ 'a/one.txt': 'x' });
    const scanner = new TypologyScanner({ config: configFor(root), logger: silentLogger });

    const result = await scanner.scan();
    assert.equal(scanner.getStatus().state, 'done');
    assert.ok(result.generatedAt);
    assert.equal(scanner.getStatus().phase, null);
    assert.equal(scanner.isRunning(), false);
  });
});