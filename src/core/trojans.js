import { EventEmitter } from 'node:events';
import { open } from 'node:fs/promises';
import path from 'node:path';

import { mapLimit } from './http.js';
import { isExpectedUnreadable, walkFiles } from './walk.js';

const HEAD_BYTES = 64 * 1024;
const MAGIC_BYTES = 512;
const PROGRESS_INTERVAL_MS = 250;
const SCORE_CAP = 24;
const HIGH_SCORE = 8;
const MEDIUM_SCORE = 4;

/** Native binaries: payloads that run without an interpreter. */
const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.dll', '.scr', '.com', '.pif', '.cpl', '.sys', '.drv', '.ocx',
  '.msi', '.msix', '.appx', '.msu', '.efi', '.gadget', '.application',
]);

/** Interpreters and script hosts Windows runs on double click or through a file association. */
const SCRIPT_EXTENSIONS = new Set([
  '.bat', '.cmd', '.ps1', '.psm1', '.ps1xml', '.vbs', '.vbe', '.jse',
  '.wsf', '.wsh', '.hta', '.reg', '.lnk', '.chm', '.sct',
]);

/** Script languages that are normal in a source tree: inspected, never flagged on their own. */
const SCRIPTISH_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.pl',
  '.php', '.lua', '.sh', '.bash', '.psd1',
]);

/** Containers that install or execute code as soon as they are opened. */
const DELIVERY_EXTENSIONS = new Set([
  '.jar', '.apk', '.iso', '.img', '.vhd', '.vhdx', '.vmdk', '.zip', '.rar',
  '.7z', '.cab', '.gz', '.bz2', '.xz', '.tar',
]);

/** Extensions that advertise the file as a document or a media file. */
const DOCUMENT_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf', '.odt', '.ods',
  '.txt', '.log', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.ini', '.cfg',
  '.conf', '.html', '.htm', '.svg', '.jpg', '.jpeg', '.png', '.gif', '.bmp',
  '.webp', '.tif', '.tiff', '.ico', '.mp3', '.mp4', '.avi', '.mkv', '.mov',
  '.wav', '.flac', '.epub', '.heic',
]);

/** Of those, the ones whose format cannot legitimately start with script text. */
const BINARY_DOCUMENT_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf', '.odt', '.ods',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.ico',
  '.mp3', '.mp4', '.avi', '.mkv', '.mov', '.wav', '.flac', '.epub', '.heic',
]);

/** Office formats that can carry VBA macros. */
const MACRO_EXTENSIONS = new Set([
  '.docm', '.dotm', '.xlsm', '.xltm', '.xlam', '.xlsb', '.pptm', '.potm', '.ppsm', '.sldm', '.ppam',
]);

const RUNNABLE_EXTENSIONS = new Set([...EXECUTABLE_EXTENSIONS, ...SCRIPT_EXTENSIONS, '.jar', '.apk']);
const CONTENT_EXTENSIONS = new Set([...SCRIPT_EXTENSIONS, ...SCRIPTISH_EXTENSIONS, ...MACRO_EXTENSIONS]);
const MAGIC_EXTENSIONS = new Set([...DOCUMENT_EXTENSIONS, ...DELIVERY_EXTENSIONS]);

/** Core service binaries: a copy outside the system folder is almost always impersonation. */
const SYSTEM_BINARIES = new Set([
  'svchost.exe', 'lsass.exe', 'csrss.exe', 'winlogon.exe', 'wininit.exe', 'smss.exe',
  'services.exe', 'lsm.exe', 'dwm.exe', 'spoolsv.exe', 'taskhostw.exe', 'dllhost.exe',
  'wmiprvse.exe', 'consent.exe', 'securityhealthservice.exe', 'securityhealthsystray.exe',
]);

/** Tool binaries that developers legitimately copy around, so they only look odd. */
const TOOL_BINARIES = new Set([
  'explorer.exe', 'rundll32.exe', 'regedit.exe', 'taskmgr.exe', 'cmd.exe', 'powershell.exe',
  'pwsh.exe', 'wscript.exe', 'cscript.exe', 'mshta.exe', 'notepad.exe', 'regsvr32.exe',
]);

/** A payload is "in the system" when any path segment is the Windows directory. */
const SYSTEM_DIR_NAMES = new Set(['windows']);

/** Right-to-left override and zero-width characters hide the real extension in Explorer. */
const SPOOFING_CHARS = /[\u202e\u202d\u202c\u200e\u200f\u200b\u200c\u200d\u2066-\u2069\ufeff]/;
const DOUBLE_EXTENSION =
  /\.(pdf|doc|docx|docm|xls|xlsx|xlsm|ppt|pptx|pptm|rtf|txt|csv|jpg|jpeg|png|gif|bmp|webp|tif|tiff|svg|mp3|mp4|avi|mkv|mov|zip|rar|7z|iso|img|html|htm|xml|json|apk|jar)\.(exe|scr|com|pif|cpl|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|msi|py|sh|jar)$/i;
// `\b` is ASCII-only, so the CJK keywords get their own substring test.
const CRACK_NAME = /\b(crack|keygen|keygens|patcher|patch|activator|activation|activat\w+|nulled|warez|serial|licen[cs]e[\s_-]*key)\b/i;
const CRACK_NAME_CJK = /注册机|破解|激活器|免激活|绿色版/;
const isCrackName = (name) => CRACK_NAME.test(name) || CRACK_NAME_CJK.test(name);

/**
 * Every heuristic the scanner can raise, with the score it contributes.
 *
 * These are name, location and byte-pattern heuristics, not a malware verdict: a real
 * antivirus still owns detection. The dashboard labels the output as triage, not proof.
 */
const NAME_RULES = [
  {
    id: 'unicode-spoofing',
    weight: 10,
    label: 'unicode spoofing in the name',
    detail: 'right-to-left override or zero-width characters make the real extension invisible in Explorer',
  },
  {
    id: 'masquerading-file',
    weight: 10,
    label: 'content does not match the extension',
    detail: 'the first bytes are an executable or a script, not the document or media file the name claims',
  },
  {
    id: 'double-extension',
    weight: 9,
    label: 'double extension',
    detail: 'a document or media extension in front of an executable one, e.g. invoice.pdf.exe',
  },
  {
    id: 'system-binary-impersonation',
    weight: 9,
    label: 'impersonates a Windows service binary',
    detail: 'same name as a core system process, stored outside the Windows directory',
  },
  {
    id: 'startup-persistence',
    weight: 8,
    label: 'sits in a startup folder',
    detail: 'it runs automatically on every login',
  },
  {
    id: 'trailing-characters',
    weight: 7,
    label: 'trailing dot or space',
    detail: 'Windows silently drops it, so the visible extension lies',
  },
  {
    id: 'tool-binary-impersonation',
    weight: 5,
    label: 'copies of a Windows tool binary',
    detail: 'legitimate copies are common, so this is a low-confidence hint',
  },
  {
    id: 'hot-directory',
    weight: 4,
    label: 'runnable file in a download, desktop or temp folder',
    detail: 'the usual landing zone for a drive-by download',
  },
  {
    id: 'cold-directory',
    weight: 2,
    label: 'runnable file in a download or temp folder',
    detail: 'same location signal as a fresh download, but the file is old',
  },
  {
    id: 'macro-document',
    weight: 4,
    label: 'macro-enabled document',
    detail: 'VBA macros run with the document',
  },
  {
    id: 'crack-name',
    weight: 4,
    label: 'crack or keygen naming',
    detail: 'names associated with licence bypass tooling, a common malware lure',
  },
  {
    id: 'anonymous-executable',
    weight: 3,
    label: 'random-looking executable name',
    detail: 'opaque name with no words, unlike anything a human installs',
  },
  {
    id: 'script-file',
    weight: 2,
    label: 'script that runs on Windows',
    detail: 'bat/cmd/ps1/vbs style file: harmless in a project, dangerous when dropped by a download',
  },
];

const CONTENT_RULES = [
  {
    id: 'defender-evasion',
    weight: 9,
    label: 'security tooling tampering',
    detail: 'mentions AMSI or ETW patching, or reconfigures Defender',
    patterns: [
      /amsiInitFailed/i,
      /AmsiScanBuffer/,
      /EtwEventWrite/,
      /Set-MpPreference/i,
      /DisableRealtimeMonitoring/i,
      /Add-MpPreference\s+-Exclusion/i,
      /MpCmdRun\.exe[^\n]{0,80}-Disable/i,
    ],
  },
  {
    id: 'obfuscated-payload',
    weight: 8,
    label: 'obfuscated or encoded payload',
    detail: 'long base64 blobs, encoded PowerShell commands or hex escape sequences',
    patterns: [
      /[A-Za-z0-9+/]{400,}={0,2}/,
      /-[eE][ncodedCommand]*\s+[A-Za-z0-9+/]{60,}/,
      /(?:\\x[0-9a-fA-F]{2}){16,}/,
      /FromBase64String/i,
      /String\.fromCharCode\((?:\s*\d+\s*,){20,}/,
    ],
  },
  {
    id: 'remote-payload',
    weight: 7,
    label: 'fetches or launches remote code',
    detail: 'download APIs, script hosts or living-off-the-land launchers',
    patterns: [
      /Invoke-WebRequest/i,
      /DownloadString/i,
      /DownloadFile/i,
      /Net\.WebClient/i,
      /WinHttpRequest/i,
      /XMLHttp/i,
      /ADODB\.Stream/i,
      /certutil[^\n]{0,60}-urlcache/i,
      /bitsadmin[^\n]{0,60}\/(?:transfer|add)/i,
      /WScript\.Shell/i,
      /Shell\.Run/i,
      /rundll32\.exe[^\n]{0,40},/i,
      /regsvr32\.exe[^\n]{0,60}\//i,
      /mshta\.exe/i,
    ],
  },
  {
    id: 'persistence',
    weight: 6,
    label: 'persistence mechanism',
    detail: 'Run keys, scheduled tasks, services or startup folder writes',
    patterns: [
      /CurrentVersion\\+Run/i,
      /schtasks\b/i,
      /\breg(?:\.exe)?\s+add\b/i,
      /New-Service\b/i,
      /ActiveSetup\\+Installed/i,
      /Copy-Item[^\n]{0,160}Start ?Menu[^\n]{0,60}Startup/i,
    ],
  },
  {
    id: 'dynamic-execution',
    weight: 5,
    label: 'dynamic code execution',
    detail: 'eval / Execute / Invoke-Expression over generated or decoded code',
    exts: new Set(['.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.jse', '.wsf', '.wsh', '.hta', '.js', '.mjs', '.cjs']),
    patterns: [/\beval\s*\(/, /\bExecute(?:Global)?\s*\(/, /Invoke-Expression/i, /\bIEX\s*\(/i, /\bexec\s*\(/i, /ActiveXObject/i, /WScript\.CreateObject/i],
  },
];

export const TROJAN_RULES = Object.freeze([...NAME_RULES, ...CONTENT_RULES].map(({ id, weight, label, detail }) => ({ id, weight, label, detail })));

const RULE_BY_ID = new Map(TROJAN_RULES.map((rule) => [rule.id, rule]));

/** Severity bands over the summed rule weights. */
export function severityFor(score) {
  if (score >= HIGH_SCORE) return 'high';
  if (score >= MEDIUM_SCORE) return 'medium';
  return 'low';
}

const escapeControl = (value) =>
  value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`);

const normalizePath = (value) => value.replaceAll('\\', '/').toLowerCase().replace(/\/+$/, '');

function isInside(target, dir) {
  const normalizedTarget = normalizePath(target);
  const normalizedDir = normalizePath(dir);
  return normalizedTarget === normalizedDir || normalizedTarget.startsWith(`${normalizedDir}/`);
}

/** Classifies a folder as `startup`, a hot landing zone (`downloads`, `desktop`, `temp`, ...) or null. */
function locate(dir, { hotDirs, hotDirNames, startupDirs }) {
  for (const candidate of startupDirs) if (isInside(dir, candidate)) return 'startup';
  for (const candidate of hotDirs) {
    if (isInside(dir, candidate)) return path.basename(candidate).toLowerCase() || 'temp';
  }
  for (const segment of dir.split(/[\\/]/)) {
    const name = segment.toLowerCase();
    if (hotDirNames.has(name)) return name;
  }
  return null;
}

function isSystemPath(dir) {
  return dir.split(/[\\/]/).some((segment) => SYSTEM_DIR_NAMES.has(segment.toLowerCase()));
}

/** Best-effort type of the file head; only the kinds the rules care about are named. */
export function sniffType(head) {
  if (!head || head.length < 2) return 'empty';
  if (head[0] === 0x4d && head[1] === 0x5a) return 'pe';
  if (head.length >= 4) {
    const be = head.readUInt32BE(0);
    if (be === 0x7f454c46) return 'elf';
    if (be === 0xfeedface || be === 0xfeedfacf || be === 0xcefaedfe || be === 0xcffaedfe) return 'macho';
  }
  const text = head.subarray(0, 16).toString('latin1');
  if (text.startsWith('#!')) return 'script';
  if (/^(@echo\b|rem\s|:<<|goto\s+:)/i.test(text)) return 'script';
  if (text.startsWith('%PDF')) return 'pdf';
  if (text.startsWith('PK')) return 'zip';
  if (text.startsWith('Rar!')) return 'rar';
  if (text.startsWith('GIF8')) return 'gif';
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpeg';
  if (head[0] === 0x89 && head[1] === 0x50) return 'png';
  return 'data';
}

function isMostlyUtf16(head) {
  const sample = head.subarray(0, Math.min(head.length, 256));
  let pairs = 0;
  let zeros = 0;
  for (let i = 0; i + 1 < sample.length; i += 2) {
    pairs += 1;
    if (sample[i + 1] === 0) zeros += 1;
  }
  return pairs > 0 && zeros / pairs > 0.4;
}

/** Decodes the head for pattern matching, adding a UTF-16 view so encoded scripts still match. */
function headText(head) {
  const latin = head.toString('latin1');
  if (!isMostlyUtf16(head)) return latin;
  const usable = head.length - (head.length % 2);
  return `${head.subarray(0, usable).toString('utf16le')}\n${latin}`;
}

/**
 * Scores one file against every heuristic. Pure: the caller supplies the optional
 * `head` buffer, so the same rules are testable without touching a disk.
 */
export function inspectFile(file, { head = null, hotDirs = [], hotDirNames = new Set(), startupDirs = [], recentDays = 30, now = Date.now() } = {}) {
  const reasons = [];
  const add = (id, detail) => {
    const rule = RULE_BY_ID.get(id);
    if (rule) reasons.push({ id, label: rule.label, detail, weight: rule.weight });
  };

  const name = file.name ?? path.basename(file.path);
  const trimmed = name.replace(/[. ]+$/, '');
  const ext = path.extname(trimmed).toLowerCase();
  const stem = path.basename(trimmed, ext);
  const dir = file.dir ?? path.dirname(file.path);
  const runnable = RUNNABLE_EXTENSIONS.has(ext);
  const location = locate(dir, { hotDirs, hotDirNames, startupDirs });
  const magic = head ? sniffType(head) : null;
  const ageDays = Math.max(0, Math.round((now - Date.parse(file.modifiedAt)) / 86_400_000));

  if (SPOOFING_CHARS.test(name)) add('unicode-spoofing', `codepoints in "${escapeControl(name)}"`);
  if (DOUBLE_EXTENSION.test(trimmed)) add('double-extension', `name ends with .${ext.slice(1)}`);

  // A renamed payload shows up either as a fake document or as a fake archive container.
  const declared = DOCUMENT_EXTENSIONS.has(ext) || DELIVERY_EXTENSIONS.has(ext);
  const masqueradeMagic = BINARY_DOCUMENT_EXTENSIONS.has(ext) ? ['pe', 'elf', 'macho', 'script'] : ['pe', 'elf', 'macho'];
  if (declared && magic && masqueradeMagic.includes(magic)) {
    add('masquerading-file', `declared .${ext.slice(1)} but the bytes are a ${magic.toUpperCase()} image`);
  }

  if (name !== trimmed && runnable) add('trailing-characters', `real extension .${ext.slice(1)}`);

  if (ext === '.exe' && !isSystemPath(dir)) {
    if (SYSTEM_BINARIES.has(trimmed.toLowerCase())) {
      add('system-binary-impersonation', `${trimmed} outside the Windows directory`);
    } else if (TOOL_BINARIES.has(trimmed.toLowerCase())) {
      add('tool-binary-impersonation', `${trimmed} outside the Windows directory`);
    }
  }

  if (runnable && location === 'startup') {
    add('startup-persistence', `in ${dir}`);
  } else if (runnable && location) {
    add(ageDays <= recentDays ? 'hot-directory' : 'cold-directory', `in ${location}, modified ${ageDays}d ago`);
  }

  if (MACRO_EXTENSIONS.has(ext)) add('macro-document', `.${ext.slice(1)} can run VBA macros`);
  if (isCrackName(trimmed) && (runnable || DELIVERY_EXTENSIONS.has(ext))) {
    add('crack-name', 'name carries a crack, keygen or activation keyword');
  }
  if (runnable && /^[a-z0-9]{24,}$/i.test(stem)) add('anonymous-executable', `name is ${stem.length} opaque characters`);
  if (SCRIPT_EXTENSIONS.has(ext)) add('script-file', `.${ext.slice(1)} runs through a Windows script host`);

  if (head && CONTENT_EXTENSIONS.has(ext)) {
    const text = headText(head);
    for (const rule of CONTENT_RULES) {
      if (rule.exts && !rule.exts.has(ext)) continue;
      const hit = rule.patterns.find((pattern) => pattern.test(text));
      if (hit) add(rule.id, `matched /${hit.source.slice(0, 60)}/ in the first ${Math.min(head.length, HEAD_BYTES)} bytes`);
    }
  }

  const score = Math.min(SCORE_CAP, reasons.reduce((sum, reason) => sum + reason.weight, 0));
  return {
    path: file.path,
    name,
    dir,
    ext,
    size: file.size,
    modifiedAt: file.modifiedAt,
    ageDays,
    location,
    magic,
    score,
    severity: reasons.length ? severityFor(score) : 'none',
    reasons,
  };
}

/** Reads at most `bytes` from the head of a file; huge files never land in memory. */
async function readHead(filePath, bytes) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function headBytesFor(ext) {
  if (CONTENT_EXTENSIONS.has(ext)) return HEAD_BYTES;
  if (MAGIC_EXTENSIONS.has(ext)) return MAGIC_BYTES;
  return 0;
}

/**
 * Read-only trojan triage.
 *
 * Walks the configured roots, then scores every file from its name, its folder and
 * the first bytes of its content. Nothing is executed, quarantined, moved or deleted:
 * the scanner only produces a ranked list of suspects for a human to review.
 *
 * Emits `update` with `{ status, result }` on every transition and on throttled
 * progress ticks, so the HTTP layer can push straight to the browser.
 */
export class TrojanScanner extends EventEmitter {
  #exclude;
  #hotDirNames;
  #running = false;
  #cancelled = false;
  #progressAt = 0;
  #result = null;
  #status;

  constructor({ config, logger = console }) {
    super();
    this.config = config;
    this.logger = logger;
    this.#exclude = new Set((config.exclude ?? []).map((name) => name.toLowerCase()));
    this.#hotDirNames = new Set((config.hotDirNames ?? []).map((name) => name.toLowerCase()));
    this.#status = {
      state: 'idle',
      phase: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      roots: [...(config.roots ?? [])],
      filesSeen: 0,
      inspected: 0,
      findings: 0,
      unreadable: 0,
      skippedDirs: 0,
      truncated: false,
      error: null,
    };
  }

  getStatus() {
    return { ...this.#status };
  }

  getResult() {
    return this.#result;
  }

  /** Everything the UI needs in a single payload. */
  snapshot() {
    return { status: this.getStatus(), result: this.#result };
  }

  isRunning() {
    return this.#running;
  }

  cancel() {
    if (this.#running) this.#cancelled = true;
  }

  /** Kicks off a scan without waiting; failures land in `status.error`. */
  start() {
    if (this.#running) throw new Error('a trojan scan is already running');
    this.scan().catch((error) => {
      this.logger.error?.(`trojan scan failed: ${error.message}`);
    });
    return this.getStatus();
  }

  async scan() {
    if (this.#running) throw new Error('a trojan scan is already running');
    this.#running = true;
    this.#cancelled = false;
    this.#result = null;
    this.#status = {
      ...this.#status,
      state: 'scanning',
      phase: 'walking',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      filesSeen: 0,
      inspected: 0,
      findings: 0,
      unreadable: 0,
      skippedDirs: 0,
      truncated: false,
      error: null,
    };
    this.#emitUpdate(true);

    const startedAt = Date.now();
    try {
      const files = await this.#walk();
      if (this.#cancelled) return this.#finish(startedAt, 'cancelled');

      this.#status.phase = 'inspecting';
      this.#status.filesSeen = files.length;
      this.#emitUpdate(true);

      const findings = await this.#inspect(files);
      if (this.#cancelled) return this.#finish(startedAt, 'cancelled');

      this.#result = this.#buildResult(findings, startedAt);
      return this.#finish(startedAt, 'done');
    } catch (error) {
      this.#status.error = error.message;
      this.logger.error?.(`trojan scan failed: ${error.message}`);
      return this.#finish(startedAt, 'error');
    } finally {
      this.#running = false;
    }
  }

  #finish(startedAt, state) {
    this.#status.state = state;
    this.#status.phase = null;
    this.#status.finishedAt = new Date().toISOString();
    this.#status.durationMs = Date.now() - startedAt;
    this.#emitUpdate(true);
    return this.#result;
  }

  async #walk() {
    const { roots, maxFiles, maxDepth, minSizeBytes, maxFileBytes, concurrency } = this.config;
    const { files, unreadable, skippedDirs, truncated } = await walkFiles({
      roots,
      exclude: [...this.#exclude],
      maxFiles,
      maxDepth,
      concurrency,
      minSizeBytes,
      maxFileBytes,
      isCancelled: () => this.#cancelled,
      onProgress: (count) => {
        this.#status.filesSeen = count;
        this.#emitUpdate();
      },
      onUnreadable: (where, error) => {
        this.#status.unreadable += 1;
        if (!isExpectedUnreadable(error)) {
          this.logger.warn?.(`trojan scan skipped ${where}: ${error.code ?? error.message}`);
        }
      },
    });

    this.#status.filesSeen = files.length;
    this.#status.unreadable = unreadable;
    this.#status.skippedDirs = skippedDirs;
    this.#status.truncated = truncated;
    this.#emitUpdate();
    return files;
  }

  async #inspect(files) {
    const { concurrency, hotDirs = [], startupDirs = [], recentDays = 30, maxInspectBytes = 0 } = this.config;
    const options = { hotDirs, hotDirNames: this.#hotDirNames, startupDirs, recentDays };
    const findings = [];

    await mapLimit(files, concurrency, async (file) => {
      if (this.#cancelled) return;
      try {
        const ext = path.extname(file.name.replace(/[. ]+$/, '')).toLowerCase();
        const wanted = headBytesFor(ext);
        const overCap = maxInspectBytes > 0 && file.size > maxInspectBytes;
        const head = wanted > 0 && !overCap ? await readHead(file.path, Math.min(wanted, file.size || wanted)) : null;
        const finding = inspectFile(file, { ...options, head });
        if (finding.reasons.length) findings.push(finding);
      } catch (error) {
        this.#status.unreadable += 1;
        if (!isExpectedUnreadable(error)) {
          this.logger.warn?.(`trojan scan skipped ${file.path}: ${error.code ?? error.message}`);
        }
      } finally {
        this.#status.inspected += 1;
        if (this.#status.inspected % 25 === 0) this.#emitUpdate();
      }
    });

    return findings;
  }

  #buildResult(findings, startedAt) {
    const flagged = findings.filter((finding) => finding.reasons.length > 0);
    flagged.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, undefined, { numeric: true }));

    const severity = { high: 0, medium: 0, low: 0 };
    const byRule = new Map();
    for (const finding of flagged) {
      severity[finding.severity] += 1;
      for (const reason of finding.reasons) byRule.set(reason.id, (byRule.get(reason.id) ?? 0) + 1);
    }

    const shown = flagged.slice(0, this.config.topFindings);
    this.#status.findings = flagged.length;
    return {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      roots: [...this.#status.roots],
      findingsShown: shown.length,
      findingsTruncated: flagged.length > shown.length,
      findings: shown,
      totals: {
        filesSeen: this.#status.filesSeen,
        inspected: this.#status.inspected,
        findings: flagged.length,
        high: severity.high,
        medium: severity.medium,
        low: severity.low,
        bytes: flagged.reduce((sum, finding) => sum + finding.size, 0),
      },
      topRules: [...byRule.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 8)
        .map(([id, count]) => ({ id, count, label: RULE_BY_ID.get(id)?.label ?? id })),
    };
  }

  #emitUpdate(force = false) {
    const now = Date.now();
    if (!force && now - this.#progressAt < PROGRESS_INTERVAL_MS) return;
    this.#progressAt = now;
    this.emit('update', this.snapshot());
  }
}
