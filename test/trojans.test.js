import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { inspectFile, severityFor, sniffType, TROJAN_RULES, TrojanScanner } from '../src/core/trojans.js';

const silentLogger = { warn() {}, error() {} };
const tempDirs = [];

async function makeTree(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trojans-test-'));
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
  exclude: ['node_modules', '.git'],
  hotDirs: [path.join(root, 'Downloads')],
  hotDirNames: ['Downloads', 'Desktop'],
  startupDirs: [path.join(root, 'Startup')],
  minSizeBytes: 1,
  maxFileBytes: 0,
  maxInspectBytes: 8 * 1024 * 1024,
  maxFiles: 10_000,
  maxDepth: 12,
  concurrency: 4,
  topFindings: 100,
  recentDays: 30,
  ...overrides,
});

/** Minimal file record, as the walk would produce it. */
const asFile = (name, overrides = {}) => ({
  path: `C:\\Users\\me\\${name}`,
  name,
  dir: 'C:\\Users\\me',
  size: 1024,
  modifiedAt: new Date().toISOString(),
  ...overrides,
});

const reasonsFor = (name, options = {}) => inspectFile(asFile(name), options).reasons.map((reason) => reason.id);

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('inspectFile name heuristics', () => {
  it('flags a document name hiding an executable extension', () => {
    const reasons = reasonsFor('invoice.pdf.exe');
    assert.ok(reasons.includes('double-extension'));
    assert.equal(inspectFile(asFile('invoice.pdf.exe')).severity, 'high');
  });

  it('flags right-to-left override characters used to spoof the extension', () => {
    const reasons = reasonsFor(`pnet\u202Egnp.exe`);
    assert.ok(reasons.includes('unicode-spoofing'));
  });

  it('flags a trailing dot because windows hides the real extension', () => {
    assert.ok(reasonsFor('setup.exe.').includes('trailing-characters'));
    assert.ok(reasonsFor('setup.exe ').includes('trailing-characters'));
  });

  it('flags a system service binary stored outside the windows directory', () => {
    const finding = inspectFile(asFile('svchost.exe', { dir: 'C:\\Users\\me\\Downloads' }));
    assert.ok(finding.reasons.some((reason) => reason.id === 'system-binary-impersonation'));
    assert.equal(finding.severity, 'high');
  });

  it('accepts the same binary name inside the windows directory', () => {
    const finding = inspectFile(asFile('svchost.exe', { dir: 'C:\\Windows\\System32' }));
    assert.equal(finding.reasons.length, 0);
  });

  it('scores a copied tool binary lower than an impersonated service', () => {
    const service = inspectFile(asFile('lsass.exe', { dir: 'C:\\Users\\me' }));
    const tool = inspectFile(asFile('cmd.exe', { dir: 'C:\\Users\\me' }));
    assert.ok(service.score > tool.score);
  });

  it('flags a random-looking executable name', () => {
    assert.ok(reasonsFor('a8f3c1b90e4d47a2b6c8d0e1f2a3b4c5.exe').includes('anonymous-executable'));
  });

  it('flags crack and keygen naming on runnable and archive files', () => {
    assert.ok(reasonsFor('photoshop-keygen.exe').includes('crack-name'));
    assert.ok(reasonsFor('adobe-crack.zip').includes('crack-name'));
  });

  it('flags a macro-enabled document', () => {
    assert.ok(reasonsFor('invoice.docm').includes('macro-document'));
  });
});

describe('inspectFile location heuristics', () => {
  it('flags a runnable file in a configured hot directory', () => {
    const finding = inspectFile(asFile('tool.exe', { dir: 'C:\\Users\\me\\Downloads' }), {
      hotDirs: ['C:\\Users\\me\\Downloads'],
      hotDirNames: new Set(['Downloads']),
    });
    assert.ok(finding.reasons.some((reason) => reason.id === 'hot-directory'));
    assert.equal(finding.location, 'downloads');
  });

  it('matches a hot directory by folder name alone', () => {
    const finding = inspectFile(asFile('tool.exe', { dir: '/mnt/data/Desktop' }), {
      hotDirs: [],
      hotDirNames: new Set(['downloads', 'desktop']),
    });
    assert.equal(finding.location, 'desktop');
    assert.equal(finding.severity, 'medium');
  });

  it('downgrades an old file in a hot directory', () => {
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const finding = inspectFile(asFile('tool.exe', { dir: 'C:\\Users\\me\\Downloads', modifiedAt: old }), {
      hotDirs: ['C:\\Users\\me\\Downloads'],
      hotDirNames: new Set(),
      recentDays: 30,
    });
    assert.ok(finding.reasons.some((reason) => reason.id === 'cold-directory'));
    assert.equal(finding.severity, 'low');
  });

  it('flags a payload in a startup folder as high severity', () => {
    const finding = inspectFile(asFile('update.vbs', { dir: 'C:\\Users\\me\\AppData\\Startup' }), {
      startupDirs: ['C:\\Users\\me\\AppData\\Startup'],
    });
    assert.ok(finding.reasons.some((reason) => reason.id === 'startup-persistence'));
    assert.equal(finding.severity, 'high');
  });

  it('leaves a plain source file alone', () => {
    const finding = inspectFile(asFile('index.js', { dir: 'C:\\Users\\me\\projects\\web\\src' }));
    assert.deepEqual(finding.reasons, []);
    assert.equal(finding.score, 0);
    assert.equal(finding.severity, 'none');
  });
});

describe('inspectFile content heuristics', () => {
  const pe = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(64)]);

  it('sniffs the file type from the first bytes', () => {
    assert.equal(sniffType(pe), 'pe');
    assert.equal(sniffType(Buffer.from('%PDF-1.7')), 'pdf');
    assert.equal(sniffType(Buffer.from('PK\u0003\u0004')), 'zip');
    assert.equal(sniffType(Buffer.from('#!/bin/sh\necho hi')), 'script');
    assert.equal(sniffType(Buffer.from('just some notes')), 'data');
  });

  it('flags a pe binary wearing a document extension', () => {
    const finding = inspectFile(asFile('scan.pdf'), { head: pe });
    assert.ok(finding.reasons.some((reason) => reason.id === 'masquerading-file'));
    assert.equal(finding.severity, 'high');
  });

  it('flags a pe binary wearing an archive extension', () => {
    const finding = inspectFile(asFile('photos.zip'), { head: pe });
    assert.ok(finding.reasons.some((reason) => reason.id === 'masquerading-file'));
  });

  it('does not flag a real document', () => {
    const finding = inspectFile(asFile('invoice.pdf'), { head: Buffer.from('%PDF-1.7\n1 0 obj') });
    assert.deepEqual(finding.reasons, []);
  });

  it('flags defender tampering in a powershell script', () => {
    const head = Buffer.from('$a = New-Object -ComObject WScript.Shell\nSet-MpPreference -DisableRealtimeMonitoring $true\n');
    const finding = inspectFile(asFile('setup.ps1', { dir: 'C:\\Users\\me\\Downloads' }), { head });
    assert.ok(finding.reasons.some((reason) => reason.id === 'defender-evasion'));
    assert.equal(finding.severity, 'high');
  });

  it('flags an encoded powershell command in a utf-16 script', () => {
    const head = Buffer.from('powershell.exe -enc SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQAIABOAGUAdAAuAFcAZQBiAEMAbABpAGUAbgB0AA==', 'utf16le');
    const finding = inspectFile(asFile('run.ps1'), { head });
    assert.ok(finding.reasons.some((reason) => reason.id === 'obfuscated-payload'));
  });

  it('flags a long base64 blob', () => {
    const finding = inspectFile(asFile('payload.js'), { head: Buffer.from(`const blob = "${'A'.repeat(500)}";`) });
    assert.ok(finding.reasons.some((reason) => reason.id === 'obfuscated-payload'));
  });

  it('flags a run key write as persistence', () => {
    const finding = inspectFile(asFile('install.bat'), { head: Buffer.from('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v Updater') });
    assert.ok(finding.reasons.some((reason) => reason.id === 'persistence'));
  });

  it('ignores content rules for extensions that are never read as scripts', () => {
    const finding = inspectFile(asFile('notes.txt'), { head: Buffer.from('eval(FromBase64String(abcdef))') });
    assert.deepEqual(finding.reasons, []);
  });
});

describe('severity bands', () => {
  it('maps the summed rule weights to a band', () => {
    assert.equal(severityFor(0), 'low');
    assert.equal(severityFor(4), 'medium');
    assert.equal(severityFor(8), 'high');
    assert.equal(severityFor(100), 'high');
  });

  it('caps the score so one file cannot dominate the ranking', () => {
    const head = Buffer.from('Set-MpPreference -DisableRealtimeMonitoring\nreg add HKCU\\CurrentVersion\\Run\npowershell -enc AAAA\n');
    const finding = inspectFile(asFile(`${'a'.repeat(40)}.pdf.exe`), { head });
    assert.ok(finding.score <= 24);
  });

  it('exposes every rule with a label and a weight', () => {
    assert.ok(TROJAN_RULES.length >= 15);
    for (const rule of TROJAN_RULES) {
      assert.equal(typeof rule.id, 'string');
      assert.ok(rule.weight > 0);
      assert.ok(rule.label.length > 3);
    }
  });

  it('gives every rule id a unique name', () => {
    const ids = TROJAN_RULES.map((rule) => rule.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('TrojanScanner', () => {
  it('ranks the suspects it finds and counts them by severity', async () => {
    const root = await makeTree({
      'Downloads/invoice.pdf.exe': Buffer.from([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3, 4]),
      'Downloads/report.pdf': Buffer.from([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3, 4]),
      'Downloads/payload.ps1': 'Set-MpPreference -DisableRealtimeMonitoring $true\n',
      'projects/web/src/index.js': 'export const ok = true;\n',
      'notes.txt': 'shopping list\n',
    });

    const scanner = new TrojanScanner({ config: configFor(root), logger: silentLogger });
    const result = await scanner.scan();

    assert.equal(result.totals.findings, 3);
    assert.equal(result.totals.high, 3);
    assert.equal(result.findings[0].score >= result.findings[1].score, true);
    assert.equal(result.findings[0].severity, 'high');
    assert.deepEqual(
      result.findings.map((finding) => path.basename(finding.path)).sort(),
      ['invoice.pdf.exe', 'payload.ps1', 'report.pdf'],
    );
    assert.ok(result.topRules.some((rule) => rule.id === 'double-extension'));
    assert.ok(result.topRules.some((rule) => rule.id === 'masquerading-file'));
  });

  it('reports a clean tree without inventing findings', async () => {
    const root = await makeTree({
      'projects/web/src/index.js': 'export const ok = true;\n',
      'Documents/report.pdf': Buffer.from('%PDF-1.7\n1 0 obj\n'),
    });

    const scanner = new TrojanScanner({ config: configFor(root), logger: silentLogger });
    const result = await scanner.scan();

    assert.deepEqual(result.findings, []);
    assert.equal(result.totals.findings, 0);
    assert.deepEqual(result.topRules, []);
  });

  it('skips excluded directory names', async () => {
    const root = await makeTree({
      'keep/invoice.pdf.exe': Buffer.from([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3, 4]),
      'node_modules/invoice.pdf.exe': Buffer.from([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3, 4]),
    });

    const scanner = new TrojanScanner({ config: configFor(root), logger: silentLogger });
    const result = await scanner.scan();

    assert.equal(result.totals.findings, 1);
    assert.equal(result.findings.every((finding) => !finding.path.includes('node_modules')), true);
  });

  it('caps the reported findings and flags the truncation', async () => {
    const files = {};
    for (let i = 0; i < 5; i += 1) files[`Downloads/payload-${i}.pdf.exe`] = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3, 4]);
    const root = await makeTree(files);

    const scanner = new TrojanScanner({ config: configFor(root, { topFindings: 2 }), logger: silentLogger });
    const result = await scanner.scan();

    assert.equal(result.findings.length, 2);
    assert.equal(result.findingsShown, 2);
    assert.equal(result.findingsTruncated, true);
    assert.equal(result.totals.findings, 5);
  });

  it('survives unreadable roots and reports them', async () => {
    const root = await makeTree({ 'Downloads/a.exe': 'MZ binary' });
    const missing = path.join(root, 'does-not-exist');

    const scanner = new TrojanScanner({ config: configFor(root, { roots: [missing, root] }), logger: silentLogger });
    const result = await scanner.scan();

    assert.equal(scanner.getStatus().unreadable, 1);
    assert.equal(result.totals.findings >= 1, true);
  });

  it('does not read the bytes of a file above the inspect cap', async () => {
    const root = await makeTree({ 'Downloads/big.pdf.exe': Buffer.alloc(4096, 0x41) });

    const scanner = new TrojanScanner({ config: configFor(root, { maxInspectBytes: 16 }), logger: silentLogger });
    const result = await scanner.scan();

    const [finding] = result.findings;
    assert.ok(finding.reasons.some((reason) => reason.id === 'double-extension'));
    assert.equal(finding.reasons.some((reason) => reason.id === 'masquerading-file'), false);
  });

  it('reports scan state through the status snapshot', async () => {
    const root = await makeTree({ 'Downloads/a.exe': 'MZ', 'b.txt': 'hello' });

    const scanner = new TrojanScanner({ config: configFor(root), logger: silentLogger });
    assert.equal(scanner.getStatus().state, 'idle');
    assert.equal(scanner.isRunning(), false);
    assert.deepEqual(scanner.snapshot().result, null);

    const states = [];
    scanner.on('update', (payload) => states.push(payload.status.state));
    await scanner.scan();

    const status = scanner.getStatus();
    assert.equal(status.state, 'done');
    assert.equal(status.phase, null);
    assert.equal(status.filesSeen, 2);
    assert.equal(status.inspected, 2);
    assert.equal(status.findings, scanner.getResult().totals.findings);
    assert.ok(states.includes('scanning'));
    assert.ok(states.includes('done'));
    assert.equal(scanner.isRunning(), false);
  });

  it('rejects a second scan while one is in flight', async () => {
    const root = await makeTree({ 'a.txt': 'hello' });
    const scanner = new TrojanScanner({ config: configFor(root), logger: silentLogger });

    const first = scanner.scan();
    assert.equal(scanner.isRunning(), true);
    await assert.rejects(scanner.scan(), /already running/);
    await assert.rejects(async () => scanner.start(), /already running/);
    await first;
    assert.equal(scanner.isRunning(), false);
  });

  it('never writes to or removes anything under the scanned roots', async () => {
    const root = await makeTree({ 'Downloads/a.exe': 'MZ', 'Downloads/b.pdf': '%PDF-1.7' });
    const { readdir, stat } = await import('node:fs/promises');
    const snapshot = async () => {
      const entries = new Map();
      const walk = async (dir) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else entries.set(full, (await stat(full)).size);
        }
      };
      await walk(root);
      return [...entries.entries()].sort();
    };

    const before = await snapshot();
    const scanner = new TrojanScanner({ config: configFor(root), logger: silentLogger });
    await scanner.scan();
    assert.deepEqual(await snapshot(), before);
  });
});
