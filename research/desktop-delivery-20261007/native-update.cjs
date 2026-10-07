'use strict';
// Guarded Windows delivery update: replaces the desktop app\dist and, when changed, the
// installed @namzu/cli and @namzu/sdk runtime dist directories (whole-dist per package).
// Windows Node only.
//   node.exe native-update.cjs --source=<snapshot dir> [--meta=<dir>] (--check | --apply | --probe-only | --verify-after=<private before snapshot>)
// <snapshot dir> holds desktop-dist, cli-dist, sdk-dist and HEAD (a frozen build of one commit).
// <meta> (default ./snapshot-meta) holds cli.package.json and sdk.package.json of that commit
//   (git show <commit>:packages/<pkg>/package.json) for the dependency-equality guard.
// --check         read-only: validates source, processes, live state, runtime manifests, dependency
//                 equality; prints the exact changed files per package and plans the swap.
// --apply         runs --check, stages everything, closes the app gracefully, waits for the desktop
//                 and every runtime child to exit, swaps all dists, relaunches, verifies; any failed
//                 rename rolls every package back together.
// --probe-only    read-only: installed manifests, preload API and the network probe only.
// --verify-after  read-only: compares the running app with a private snapshot and runs the probe.
// Writes: a private snapshot inside the Development directory (drafts included) and a
// public receipt (counts, hashes, PIDs, booleans, file paths) under ./artifacts.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
assert.equal(process.platform, 'win32', 'Windows Node only');

const root = path.join(process.env.LOCALAPPDATA, 'Namzu', 'Development');
const configPath = path.join(root, 'launch.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const argValue = n => process.argv.slice(2).find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const verifyArgs = process.argv.filter(a => a.startsWith('--verify-after='));
const modes = [...['--check', '--apply', '--probe-only'].filter(m => process.argv.includes(m)), ...verifyArgs];
assert.equal(modes.length, 1, 'Select exactly one of --check, --apply, --probe-only, --verify-after=');
const mode = modes[0].startsWith('--verify-after=') ? 'verify-after' : modes[0].slice(2);
const verifyFrom = mode === 'verify-after' ? path.join(root, path.basename(modes[0].slice('--verify-after='.length))) : null;
for (const arg of process.argv.slice(2)) assert(modes.includes(arg) || arg.startsWith('--source=') || arg.startsWith('--meta='), `Unknown option ${arg}`);
assert(argValue('source'), '--source=<snapshot dir> is required');
const snapshot = path.resolve(argValue('source'));
const metaDir = path.resolve(argValue('meta') ?? path.join(__dirname, 'snapshot-meta'));
const runtimePackages = path.join(root, 'runtime', 'packages');
// Package directories are resolved by name below; p0 (cli) is fixed by launch.json.
const stamp = new Date().toISOString().replaceAll(/[-:.]/g, '');
const label = 'delivery';
const portFile = path.join(process.env.APPDATA, 'Namzu', 'DevToolsActivePort');
const pidFile = path.join(root, 'desktop.pid');
const artifacts = path.join(__dirname, 'artifacts');
const privatePath = path.join(root, `${label}-before-private-${stamp}.json`);
const REQUIRED = ['main/index.js', 'main/link-preview.js', 'main/link-preview-electron.js', 'preload.cjs', 'renderer/index.html'];

const packages = [];     // { key, name, sourceDir, targetDir, stage, backup, ... }
function resolvePackage(name) {
  for (const e of fs.readdirSync(runtimePackages)) {
    const file = path.join(runtimePackages, e, 'package.json');
    if (!fs.existsSync(file)) continue;
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).name === name) return path.join(runtimePackages, e); } catch {}
  }
  throw new Error(`Refused: runtime package ${name} not found`);
}

const hash = v => crypto.createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function manifest(dir, skip = () => false) {
  const rows = new Map();
  if (!fs.existsSync(dir)) return rows;
  (function visit(rel) {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const f = rel ? `${rel}/${e.name}` : e.name;
      if (skip(f)) continue;
      if (e.isDirectory()) visit(f);
      else { assert(e.isFile(), `Unexpected non-file in dist: ${f}`); rows.set(f, hash(fs.readFileSync(path.join(dir, f)))); }
    }
  })('');
  return rows;
}
const manifestHash = m => hash([...m].sort((a, b) => a[0].localeCompare(b[0])));
function diffLists(a, b) {
  const changed = [], added = [], removed = [];
  for (const [f, h] of b) { if (!a.has(f)) added.push(f); else if (a.get(f) !== h) changed.push(f); }
  for (const f of a.keys()) if (!b.has(f)) removed.push(f);
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}
const total = d => d.changed.length + d.added.length + d.removed.length;
// (b) build noise: source maps and type declarations only. Everything else is (a) a runtime file.
const isNoise = f => /\.(map|d\.ts|d\.cts|d\.mts)$/.test(f);
function classify(d) {
  const all = [...d.changed, ...d.added, ...d.removed];
  return { runtime: all.filter(f => !isNoise(f)).sort(), noise: all.filter(isNoise).sort() };
}
const quote = v => `'${v.replaceAll("'", "''")}'`;
function processPath(pid) {
  const r = cp.spawnSync('powershell.exe', ['-NoProfile', '-Command',
    // Without the explicit exit, a gone process leaves $? false and PowerShell exits 1.
    `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){$p.Path}; exit 0`], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, 'Process probe failed');
  return r.stdout.trim() || null;
}
// Every process that holds the install: the configured electron, and any node whose command
// line runs the configured CLI entry. Returns pid, kind and executable name only.
function ownedProcesses() {
  const script = "$e=$env:NZ_ELECTRON; $c=$env:NZ_CLI; " +
    "@(Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -eq $e) -or ($_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($c, [StringComparison]::OrdinalIgnoreCase) -ge 0) } | " +
    "ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=$_.Name; electron=($_.ExecutablePath -eq $e) } }) | ConvertTo-Json -Compress; exit 0";
  const r = cp.spawnSync('powershell.exe', ['-NoProfile', '-Command', script],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, NZ_ELECTRON: config.electron, NZ_CLI: config.cli } });
  assert.equal(r.status, 0, 'Process inventory failed');
  const text = r.stdout.trim();
  if (!text) return [];
  const v = JSON.parse(text);
  return (Array.isArray(v) ? v : [v]).map(p => ({ pid: p.pid, ppid: p.ppid, name: p.name, kind: p.electron ? 'electron' : 'runtime-node' })).sort((a, b) => a.pid - b.pid);
}
const readPid = () => Number(fs.readFileSync(pidFile, 'utf8').trim());
const port = () => Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);

const receipt = { passed: false, mode, at: new Date().toISOString(), phase: 'preflight', nativeWindows: true,
  packageInstalls: 0, modelRequests: 0, computerActions: 0, uiInteractions: 0, checks: [], observations: [] };
let browser, page;
const { chromium } = require(path.join(root, 'runtime/packages/p39'));
async function attach() {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port()}`);
  page = browser.contexts().flatMap(c => c.pages()).find(p => p.url() === new URL(config.url).href);
  assert(page, 'Exact native desktop page missing');
  page.setDefaultTimeout(60_000);
}
async function disconnect() {
  // For a connectOverCDP browser, Playwright's Browser.close() disconnects and clears
  // the contexts it created; it does not terminate the remote browser process.
  if (browser) { try { await browser.close(); } catch {} browser = page = undefined; }
}

// Adapted from the base guard (transcript-content-desktop-activation-native-20261007.cjs).
async function readState() {
  return page.evaluate(async () => {
    const api = window.namzu;
    if (!api) throw new Error('Native preload API is missing.');
    const workspace = await api.workspace();
    const currentWindow = workspace.layout.windows.find(i => i.id === workspace.windowId);
    if (!currentWindow) throw new Error('Current window has no workspace.');
    const visit = n => !n ? [] : n.kind === 'group' ? [n] : [...visit(n.first), ...visit(n.second)];
    const groups = visit(currentWindow.root);
    const projects = await api.projects();
    const catalogues = await Promise.all(projects.filter(i => i.status === 'ready').map(async i => ({ projectId: i.id, rows: await api.conversations(i.id) })));
    const conversations = catalogues.flatMap(i => i.rows);
    const profiles = await api.pals();
    const computers = await Promise.all(profiles.map(async p => {
      const c = await api.palComputer(p.id);
      if (c.control?.mode === 'transitioning') throw new Error('Pal computer control is transitioning.');
      if (c.status === 'running') throw new Error('A Pal computer is running.');
      return { id: p.id, status: c.status, generation: c.generation, environmentId: c.environmentId, control: c.control };
    }));
    const sessions = [];
    for (const group of groups) for (const id of group.tabs) {
      const view = conversations.find(i => i.id === id);
      if (!view) throw new Error('Open tab is absent from its project catalogue.');
      let history = await api.openConversation(view.projectId, id);
      if (api.readyConversation) { await api.readyConversation(view.projectId, id); history = await api.openConversation(view.projectId, id); }
      const thread = history.thread;
      if (thread?.running || thread?.responding || thread?.permissions?.length || thread?.queuedItems?.length ||
        thread?.queued?.length || thread?.activeToolIds?.length || thread?.retry?.status === 'running')
        throw new Error('An open conversation has active, queued, or permission work.');
      const jobs = await api.jobs(id);
      if (!Array.isArray(jobs) || jobs.some(j => j.status === 'running' || j.recoveryRequired))
        throw new Error('An open conversation has active or recovery work.');
      const draft = await api.draft(id);
      const editor = [...document.querySelectorAll('.composer-input textarea[aria-label="Message Namzu"]')]
        .find(i => i.closest('[data-workspace-group]')?.dataset.workspaceGroup === group.id);
      if (group.activeTabId === id && (!editor || editor.value !== draft))
        throw new Error('The visible composer is missing or differs from its saved draft.');
      sessions.push({ id, projectId: view.projectId, messages: history.messages, partial: history.partial, thread, jobs, draft,
        settings: await api.draftSettings(id), attachments: await api.attachments(id),
        provider: (await api.providers(view.projectId, id)).selected });
    }
    const sidebar = document.querySelector('#namzu-sidebar');
    const scroll = sidebar?.querySelector('.sidebar-scroll');
    const focusedGroup = groups.find(i => i.id === currentWindow.focusedGroupId);
    const pane = [...document.querySelectorAll('[data-workspace-group]')].find(i => i.dataset.workspaceGroup === focusedGroup?.id);
    const transcript = pane?.querySelector('.transcript');
    const visible = s => [...document.querySelectorAll(s)].some(i => i.getClientRects().length > 0);
    const terminalAlerts = [...document.querySelectorAll('[role="alert"]')].filter(i => i.getClientRects().length > 0).map(item => {
      const gid = item.closest('[data-workspace-group]')?.dataset.workspaceGroup;
      const g = groups.find(c => c.id === gid);
      const s = g && sessions.find(c => c.id === g.activeTabId);
      const message = item.textContent?.trim() ?? '';
      if (!item.matches('.inline-error') || !item.closest('.transcript .conversation-body') || !s ||
        s.thread?.stopReason !== 'error' || s.thread.error !== message || !message)
        throw new Error('A visible alert is not the captured idle conversation’s exact terminal error.');
      return { sessionId: s.id, error: message };
    });
    if (visible('[role="dialog"], [role="alertdialog"]') || visible('.pal-computer-view canvas') ||
      document.activeElement?.closest?.('.pal-computer-view') ||
      (document.activeElement?.matches?.('textarea,input,[contenteditable="true"]') &&
        (document.activeElement.value?.length || document.activeElement.isContentEditable)))
      throw new Error('A dialog, alert, computer canvas, or focused editor is active.');
    if (!sidebar || sidebar.inert || !scroll || !focusedGroup || !transcript)
      throw new Error('Recents or the focused conversation is not available for navigation.');
    const presentations = Object.keys(localStorage).filter(k => k.startsWith('namzu.workspace.presentation:')).sort().map(k => [k, localStorage.getItem(k)]);
    return { workspace, groups, projects, catalogues, profiles, computers, sessions, dom: {
      page: document.querySelector('.workspace')?.dataset.page,
      focusedGroupId: focusedGroup.id, activeTabId: focusedGroup.activeTabId,
      sidebarScrollTop: scroll.scrollTop,
      sidebarCollapsed: document.querySelector('.workspace-host')?.dataset.sidebarCollapsed,
      transcriptScrollTop: transcript.scrollTop, transcriptScrollRange: transcript.scrollHeight - transcript.clientHeight,
      presentations, appearance: localStorage.getItem('namzu.appearance'),
      collapsedPreference: localStorage.getItem('namzu.sidebar-collapsed'),
      focusedElement: document.activeElement?.tagName ?? null, terminalAlerts } };
  });
}
const stripMessage = ({ messageId, status, stopReason, ...body }) => body;
// Digests only; no text leaves this function.
function summarize(state) {
  const activePresentationKey = `namzu.workspace.presentation:${state.dom.activeTabId}`;
  return {
    groups: state.groups.map(g => ({ tabs: g.tabs, active: g.activeTabId, focused: g.id === state.dom.focusedGroupId })),
    sessions: state.sessions.map(s => ({
      id: hash(s.id), messageCount: s.messages.length, messageHashes: s.messages.map(m => hash(stripMessage(m))),
      draftHash: hash(s.draft ?? ''), draftLength: (s.draft ?? '').length, settingsHash: hash(s.settings ?? null),
      attachmentCount: s.attachments?.length ?? 0, attachmentsHash: hash(s.attachments ?? null),
      providerHash: hash({ id: s.settings?.choice?.provider ?? s.provider?.id, model: s.settings?.choice?.model ?? s.provider?.model }),
      jobCount: s.jobs.length })),
    computers: state.computers.map(c => ({ id: hash(c.id), status: c.status })),
    presentation: { otherEntriesHash: hash(state.dom.presentations.filter(([k]) => k !== activePresentationKey)),
      entryCount: state.dom.presentations.length, appearanceHash: hash(state.dom.appearance), collapsedHash: hash(state.dom.collapsedPreference),
      sidebarCollapsed: state.dom.sidebarCollapsed, page: state.dom.page },
    scroll: { sidebarScrollTop: state.dom.sidebarScrollTop, transcriptScrollTop: state.dom.transcriptScrollTop, transcriptScrollRange: state.dom.transcriptScrollRange },
  };
}
// The part that must be identical after the update (scroll excluded, observed only).
function protectedPart(s) {
  const { scroll, ...rest } = s;
  // sessions carry ids hashed; ids are stable across restarts for open tabs.
  return rest;
}

async function networkProbe() {
  return page.evaluate(async () => {
    const api = window.namzu;
    const out = { pages: [], images: [], refusals: [], repeat: null };
    const timed = async fn => { const t = performance.now(); const v = await fn(); return [v, Math.round(performance.now() - t)]; };
    let first = null;
    for (const url of ['https://github.com/composio-community/open-dot', 'https://huggingface.co/canberkkkkkk/ema-lightning', 'https://www.beautifului.dev/']) {
      let rec;
      try {
        const [r, ms] = await timed(() => api.linkPreview(url));
        rec = { nonNull: r !== null, finalHost: r ? new URL(r.url).host : null, headLength: r ? r.head.length : 0,
          hasOgTitle: !!r && /og:title/.test(r.head), hasOgImage: !!r && /og:image/.test(r.head), ms };
        if (r && !first) first = { url, r };
      } catch (e) { rec = { error: String(e?.message ?? e).slice(0, 120) }; }
      out.pages.push({ target: new URL(url).host, ...rec });
    }
    if (first) {
      const head = first.r.head, base = first.r.url;
      const metaImage = head.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]*>/i)?.[0];
      const image = metaImage?.match(/content=["']([^"']+)["']/i)?.[1];
      const iconTag = [...head.matchAll(/<link[^>]+>/gi)].map(m => m[0]).find(t => /rel=["'][^"']*icon[^"']*["']/i.test(t));
      const icon = iconTag?.match(/href=["']([^"']+)["']/i)?.[1];
      for (const [kind, raw] of [['image', image], ['icon', icon]]) {
        if (!raw) { out.images.push({ kind, found: false }); continue; }
        try {
          const [r, ms] = await timed(() => api.linkPreviewImage(new URL(raw.replaceAll('&amp;', '&'), base).href, kind));
          const text = typeof r === 'string' ? r : r?.dataUrl ?? r?.url ?? null;
          const m = typeof text === 'string' ? text.match(/^data:([^;,]+)[;,]/) : null;
          const b64 = typeof text === 'string' ? text.slice(text.indexOf(',') + 1) : '';
          out.images.push({ kind, found: true, nonNull: r !== null, shape: r === null ? 'null' : typeof r === 'string' ? 'string' : 'object',
            mime: m?.[1] ?? null, bytes: text ? Math.floor(b64.length * 3 / 4) : 0, ms });
        } catch (e) { out.images.push({ kind, found: true, error: String(e?.message ?? e).slice(0, 120) }); }
      }
      const [again, ms] = await timed(() => api.linkPreview(first.url));
      out.repeat = { nonNull: again !== null, ms };
    }
    for (const url of ['https://localhost/', 'https://127.0.0.1/', 'https://192.168.1.1/', 'http://example.com/', 'https://example.com:8443/', 'https://metadata.google.internal/']) {
      try { out.refusals.push({ target: url, isNull: (await api.linkPreview(url)) === null }); }
      catch (e) { out.refusals.push({ target: url, isNull: false, error: String(e?.message ?? e).slice(0, 80) }); }
    }
    return out;
  });
}

// ---- delivery set: desktop dist plus the installed CLI and SDK runtime dist directories ----
const items = [];
function buildItems() {
  const desktopTarget = path.join(config.app, 'dist');
  const defs = [
    { key: 'desktop', name: '@namzu/desktop', source: path.join(snapshot, 'desktop-dist'), target: desktopTarget, required: REQUIRED },
    { key: 'cli', name: '@namzu/cli', source: path.join(snapshot, 'cli-dist'), target: path.join(resolvePackage('@namzu/cli'), 'dist'), required: ['bin.js', 'cli.js'], meta: 'cli.package.json' },
    { key: 'sdk', name: '@namzu/sdk', source: path.join(snapshot, 'sdk-dist'), target: path.join(resolvePackage('@namzu/sdk'), 'dist'), required: ['index.js'], meta: 'sdk.package.json' },
  ];
  for (const d of defs) {
    const dir = path.dirname(d.target);
    items.push({ ...d, skip: d.meta ? packSkip(d.meta) : () => false, stage: path.join(dir, `dist-stage-${stamp}`), backup: path.join(dir, `dist-before-${label}-${stamp}`) });
  }
  assert.equal(path.join(items[1].target).toLowerCase(), path.normalize(config.cli).toLowerCase().replace(/[\\/]bin\.js$/, ''), 'Refused: the cli package is not the one launch.json runs');
}
// The installed copy is what `npm pack` ships: the package.json "files" negations (!dist/**/*.test.*,
// __tests__, ...) and the runtime's no-maps/no-declarations rule are applied to the build output
// before it is compared or staged.
function packSkip(metaFile) {
  const files = JSON.parse(fs.readFileSync(path.join(metaDir, metaFile), 'utf8')).files ?? [];
  const rules = files.filter(f => f.startsWith('!dist/**/')).map(f => {
    const seg = f.slice('!dist/**/'.length);
    assert(/^[\w.*-]+$/.test(seg), `Unsupported files pattern ${f}`);
    return new RegExp(`(^|/)${seg.replaceAll('.', '\\.').replaceAll('*', '[^/]*')}(/|$)`);
  });
  // The runtime copies are JavaScript only: source maps and declarations are never installed there.
  return rel => isNoise(rel) || rules.some(r => r.test(rel));
}
const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];
function dependencyReport(item) {
  const installed = JSON.parse(fs.readFileSync(path.join(path.dirname(item.target), 'package.json'), 'utf8'));
  const wanted = JSON.parse(fs.readFileSync(path.join(metaDir, item.meta), 'utf8'));
  assert.equal(installed.name, item.name, 'Installed package name mismatch');
  assert.equal(wanted.name, item.name, 'Snapshot package.json is for another package');
  const fields = {};
  for (const f of DEP_FIELDS) fields[f] = hash(installed[f] ?? {}) === hash(wanted[f] ?? {});
  const differing = [];
  for (const f of DEP_FIELDS) {
    const a = installed[f] ?? {}, b = wanted[f] ?? {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) differing.push(`${f}:${k}`);
  }
  return { installedVersion: installed.version, snapshotVersion: wanted.version, equal: differing.length === 0, fields, differing, dependenciesSha256: hash(wanted.dependencies ?? {}) };
}
function installedEqualsSource() {
  return items.every(i => manifestHash(manifest(i.target)) === receipt.packages[i.key].sourceManifestSha256);
}

async function verifyAfter(before) {
  await page.waitForFunction(async ids => {
    const projects = await window.namzu.projects();
    return ids.every(id => projects.some(i => i.id === id && i.status === 'ready'));
  }, before.projects.filter(i => i.status === 'ready').map(i => i.id), { timeout: 60_000 });
  await page.waitForFunction(expected => {
    const ids = [...document.querySelectorAll('.conversation-tab[data-tab-id]')].map(i => i.dataset.tabId);
    const active = document.querySelector('.conversation-tab[data-active="true"]')?.dataset.tabId;
    const editor = document.querySelector('.composer-input textarea[aria-label="Message Namzu"]');
    return JSON.stringify(ids) === JSON.stringify(expected.tabs) && active === expected.active && editor && !editor.disabled && !editor.readOnly;
  }, { tabs: before.groups[0].tabs, active: before.groups[0].activeTabId }, { timeout: 60_000 });
  await readState(); // hydrate read-only Pal presence before comparing
  receipt.phase = 'verify';
  const after = await readState();
  fs.writeFileSync(path.join(root, `${label}-after-private-${stamp}.json`), JSON.stringify({ stamp, afterPid: receipt.afterPid, state: after }), { mode: 0o600, flag: 'wx' });
  receipt.after = summarize(after);
  assert.deepEqual(protectedPart(receipt.after), protectedPart(receipt.before), 'Protected state changed across the update');
  receipt.checks.push('tabs, focus, drafts, settings, attachments, providers, messages, preferences unchanged');
  if (receipt.after.scroll.transcriptScrollRange !== receipt.before.scroll.transcriptScrollRange ||
    receipt.after.scroll.transcriptScrollTop !== receipt.before.scroll.transcriptScrollTop)
    receipt.observations.push('transcript scroll position/range differs after the update (not a failure)');
  const activeKey = `namzu.workspace.presentation:${after.dom.activeTabId}`;
  const activeBefore = hash(before.dom.presentations.find(([k]) => k === activeKey) ?? null);
  const activeAfter = hash(after.dom.presentations.find(([k]) => k === activeKey) ?? null);
  if (activeBefore !== activeAfter) receipt.observations.push('active tab presentation entry was flushed by the graceful close');
  assert(installedEqualsSource(), 'Installed dist differs from source');
  receipt.checks.push('installed desktop, cli and sdk dist manifests equal source');
  await probe();
  receipt.phase = 'complete';
  receipt.passed = true;
}
async function probe() {
  const types = await page.evaluate(() => [typeof window.namzu.linkPreview, typeof window.namzu.linkPreviewImage]);
  assert.deepEqual(types, ['function', 'function'], 'Preload does not expose the link preview API');
  receipt.checks.push('window.namzu.linkPreview and linkPreviewImage are functions');
  receipt.phase = 'probe';
  receipt.probe = await networkProbe();
  const p = receipt.probe;
  assert(p.pages.some(x => x.nonNull), 'No probed page returned a preview');
  assert(p.refusals.every(x => x.isNull), 'A refused address did not return null');
  assert(p.images.length === 2 && p.images.every(x => x.found && x.nonNull && x.mime?.startsWith('image/')), 'Image or icon fetch failed');
  assert(p.repeat?.nonNull, 'Repeat call returned null');
  if (p.pages.some(x => x.nonNull === false || x.error)) receipt.observations.push('at least one probed page returned null or errored');
  receipt.checks.push('network probe: previews, images, refusals, cached repeat');
}

(async () => {
  let before, beforePid, changedItems = [];
  try {
    fs.mkdirSync(artifacts, { recursive: true });
    receipt.launchConfigSha256 = hash(fs.readFileSync(configPath));
    buildItems();
    receipt.snapshotCommit = fs.readFileSync(path.join(snapshot, 'HEAD'), 'utf8').trim();
    assert.equal(receipt.snapshotCommit, fs.readFileSync(path.join(metaDir, 'COMMIT'), 'utf8').trim(), 'Refused: meta package.json files are for another commit');
    receipt.packages = {};
    for (const i of items) {
      for (const f of i.required) assert(fs.existsSync(path.join(i.source, f)) && fs.statSync(path.join(i.source, f)).isFile(), `Refused: ${i.key} source dist is missing ${f}`);
      assert.notEqual(i.source.toLowerCase(), i.target.toLowerCase());
      const src = manifest(i.source, i.skip), inst = manifest(i.target);
      const d = diffLists(inst, src);
      receipt.packages[i.key] = { name: i.name, installedFiles: inst.size, sourceFiles: src.size,
        installedManifestSha256: manifestHash(inst), sourceManifestSha256: manifestHash(src),
        changedCount: d.changed.length, addedCount: d.added.length, removedCount: d.removed.length,
        changed: d.changed, added: d.added, removed: d.removed, classification: classify(d), differs: total(d) > 0 };
      if (i.meta) {
        const dep = dependencyReport(i);
        receipt.packages[i.key].dependencies = dep;
      }
    }
    receipt.checks.push('source dists have all required entries');
    beforePid = readPid();
    assert(Number.isInteger(beforePid) && beforePid > 0, 'Refused: desktop.pid is invalid');
    const exe = processPath(beforePid);
    assert(exe, 'Refused: the recorded desktop process does not exist');
    assert.equal(exe.toLowerCase(), config.electron.toLowerCase(), 'Refused: process executable is not config.electron');
    receipt.beforePid = beforePid;
    receipt.checks.push('desktop.pid names the configured electron executable');
    receipt.ownedProcesses = ownedProcesses();
    receipt.phase = 'attach';
    await attach();
    receipt.checks.push('attached over CDP to the exact page');
    if (mode === 'probe-only') {
      receipt.afterPid = beforePid;
      assert(installedEqualsSource(), 'Installed dist differs from source');
      receipt.checks.push('installed desktop, cli and sdk dist manifests equal source');
      try { await probe(); receipt.passed = true; } finally { receipt.phase = 'complete'; }
      return;
    }
    if (verifyFrom) {
      const saved = JSON.parse(fs.readFileSync(verifyFrom, 'utf8'));
      before = saved.state;
      receipt.verifiedAgainst = path.basename(verifyFrom);
      receipt.before = summarize(before);
      receipt.afterPid = beforePid;
      assert.notEqual(saved.beforePid, beforePid, 'The app has not been relaunched since the snapshot');
      await verifyAfter(before);
      return;
    }
    receipt.phase = 'state';
    before = await readState();
    const priv = { stamp, beforePid, state: before };
    fs.writeFileSync(privatePath, JSON.stringify(priv), { mode: 0o600, flag: 'wx' });
    receipt.privateSnapshot = path.basename(privatePath);
    receipt.before = summarize(before);
    receipt.terminalAlertsBefore = before.dom.terminalAlerts.length;
    receipt.checks.push('live state read: idle, no dialogs, composer matches saved draft');

    receipt.phase = 'plan';
    changedItems = items.filter(i => receipt.packages[i.key].differs);
    // A new dependency needs a junction rebuild; whole-dist replacement is only safe when dependencies are identical.
    const depMismatch = items.filter(i => i.meta && !receipt.packages[i.key].dependencies.equal).map(i => i.key);
    receipt.dependenciesEqual = depMismatch.length === 0;
    assert(depMismatch.length === 0, `Refused: dependencies differ for ${depMismatch.join(', ')}; a junction rebuild is required`);
    receipt.checks.push('installed package.json dependencies equal the snapshot commit');
    assert(changedItems.length > 0, 'Refused: every installed dist already equals the source');
    receipt.plan = { replace: changedItems.map(i => i.key), stage: changedItems.map(i => path.basename(i.stage)), backup: changedItems.map(i => path.basename(i.backup)) };
    receipt.checks.push('installed dists differ from source; plan computed');
    if (mode !== 'apply') { receipt.phase = 'complete'; receipt.passed = true; return; }

    // ---- apply ----
    receipt.phase = 'stage';
    for (const i of changedItems) {
      assert(!fs.existsSync(i.stage) && !fs.existsSync(i.backup), `Stage or backup already exists for ${i.key}`);
      fs.cpSync(i.source, i.stage, { recursive: true, filter: s => !i.skip(path.relative(i.source, s).split(path.sep).join('/')) });
      assert.equal(manifestHash(manifest(i.stage)), receipt.packages[i.key].sourceManifestSha256, `Staged ${i.key} copy differs from source`);
    }
    receipt.checks.push('staged copies match source manifests');
    // The copy takes a while and the app stays in use: compare against the state
    // read right before the close, not the one read before staging.
    before = await readState();
    fs.writeFileSync(privatePath.replace('-before-private-', '-preclose-private-'), JSON.stringify({ stamp, beforePid, state: before }), { mode: 0o600, flag: 'wx' });
    receipt.before = summarize(before);
    receipt.terminalAlertsBefore = before.dom.terminalAlerts.length;
    receipt.checks.push('state re-read after staging, immediately before the close');
    receipt.processesBeforeClose = ownedProcesses();
    receipt.phase = 'close';
    await disconnect();
    const closed = cp.spawnSync(process.execPath, [path.join(root, 'close-current.cjs')], { encoding: 'utf8', windowsHide: true });
    assert.equal(closed.status, 0, 'Graceful close failed');
    const closeStart = Date.now();
    while (processPath(beforePid) || ownedProcesses().length > 0) {
      assert(Date.now() - closeStart < 60_000, 'The desktop or a runtime child process did not exit');
      await sleep(500);
    }
    receipt.checks.push('desktop and every runtime child process gone');
    receipt.phase = 'swap';
    const done = []; // { item, backedUp, staged }
    try {
      for (const i of changedItems) {
        const rec = { item: i, backedUp: false, staged: false };
        done.push(rec);
        fs.renameSync(i.target, i.backup); rec.backedUp = true;
        fs.renameSync(i.stage, i.target); rec.staged = true;
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const rec of done.reverse()) {
        try {
          if (rec.staged) fs.renameSync(rec.item.target, rec.item.stage);
          if (rec.backedUp) fs.renameSync(rec.item.backup, rec.item.target);
        } catch (e) { rollbackErrors.push(`${rec.item.key}: ${String(e.message).slice(0, 100)}`); }
      }
      cp.spawnSync(process.execPath, [path.join(root, 'launch.cjs')], { encoding: 'utf8', windowsHide: true });
      receipt.rolledBack = true;
      receipt.rollbackErrors = rollbackErrors;
      throw error;
    }
    receipt.checks.push('dists swapped; previous dists retained as backups');
    receipt.phase = 'startup';
    const oldStamp = fs.existsSync(portFile) ? fs.statSync(portFile).mtimeMs : 0;
    const launchedAt = Date.now();
    try {
      const launch = cp.spawnSync(process.execPath, [path.join(root, 'launch.cjs')], { encoding: 'utf8', windowsHide: true });
      assert.equal(launch.status, 0, 'Launcher failed');
      receipt.afterPid = readPid();
      assert.notEqual(receipt.afterPid, beforePid, 'No new process id');
      let attached = false;
      while (!attached) {
        assert(Date.now() - launchedAt < 90_000, 'Desktop did not expose its CDP page within 90 s');
        assert(processPath(readPid()), 'The new desktop process exited during startup');
        try {
          if (fs.existsSync(portFile) && fs.statSync(portFile).mtimeMs > oldStamp && fs.statSync(portFile).mtimeMs >= launchedAt - 1000 && port() > 0) {
            const pages = await fetch(`http://127.0.0.1:${port()}/json/list`, { signal: AbortSignal.timeout(2000) }).then(r => r.json());
            if (pages.some(p => p.url === new URL(config.url).href)) { await attach(); attached = true; }
          }
        } catch {}
        if (!attached) await sleep(250);
      }
    } catch (error) {
      // A build that cannot start must not strand the operator: put every previous
      // dist back (keeping the failed one for inspection) and start the old app.
      if (!processPath(readPid())) {
        const rollbackErrors = [];
        for (const i of [...changedItems].reverse()) {
          try {
            fs.renameSync(i.target, `${i.target}-failed-${stamp}`);
            fs.renameSync(i.backup, i.target);
          } catch (e) { rollbackErrors.push(`${i.key}: ${String(e.message).slice(0, 100)}`); }
        }
        cp.spawnSync(process.execPath, [path.join(root, 'launch.cjs')], { encoding: 'utf8', windowsHide: true });
        receipt.rolledBackAfterStartup = true;
        receipt.rollbackErrors = rollbackErrors;
      }
      throw error;
    }
    receipt.startupMs = Date.now() - launchedAt;
    await verifyAfter(before);
  } catch (error) {
    receipt.error = { name: error.name, message: String(error.message).replace(/\s+/g, ' ').slice(0, 300) };
    process.exitCode = 1;
    // Never leave the operator without their app: a failure after the close
    // relaunches whatever dists are in place (backups are restored on a failed swap).
    if (receipt.phase === 'close') {
      try {
        if (!processPath(readPid())) {
          cp.spawnSync(process.execPath, [path.join(root, 'launch.cjs')], { encoding: 'utf8', windowsHide: true });
          receipt.relaunchedAfterFailure = true;
        }
      } catch {}
    }
  } finally {
    await disconnect();
    const file = path.join(artifacts, `${mode}-${stamp}.json`);
    const body = JSON.stringify(receipt, null, 2) + '\n';
    try { fs.writeFileSync(file, body, { flag: 'wx' }); receipt.publicReceipt = file; } catch (e) { process.stderr.write(`receipt write failed: ${e.message}\n`); }
    process.stdout.write(body);
  }
})();
