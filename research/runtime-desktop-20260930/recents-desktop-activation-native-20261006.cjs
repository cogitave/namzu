'use strict';
// Apply the built desktop, optionally the paired reviewed CLI history/scope/Pal modules.
// No installs or guest changes. Native Windows Node:
// <script> <built dist directory> <private receipt.json>
//   [--cli-history-source=<built commands/desktop-host.js>]
//   [--cli-scope-source=<built integrations/sessions/store.js>]
//   [--cli-pal-source=<built pals/conversations.js>]
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
assert.equal(process.platform, 'win32');
const root = path.join(process.env.LOCALAPPDATA, 'Namzu', 'Development');
const configPath = path.join(root, 'launch.json');
const configBytes = fs.readFileSync(configPath);
const config = JSON.parse(configBytes);
const source = path.resolve(process.argv[2] ?? '');
const output = path.resolve(process.argv[3] ?? '');
const relative = path.relative(root, output);
assert(process.argv[2] && process.argv[3] && relative && !relative.startsWith('..') && !path.isAbsolute(relative));
const target = path.join(config.app, 'dist');
assert.notEqual(source.toLowerCase(), target.toLowerCase());
for (const file of ['main/index.js', 'main/operator.js', 'preload.cjs', 'renderer/index.html'])
  assert(fs.statSync(path.join(source, file)).isFile(), `Missing built entry ${file}`);
const { chromium } = require(path.join(root, 'runtime/packages/p39'));
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
function manifest(directory) {
  const rows = [];
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(file);
      else { assert(entry.isFile()); rows.push({ file: file.replaceAll(path.sep, '/'), hash: hash(fs.readFileSync(path.join(directory, file))) }); }
    }
  }
  visit(''); return rows.sort((a, b) => a.file.localeCompare(b.file));
}
const stamp = new Date().toISOString().replaceAll(/[-:.]/g, '');
const staging = path.join(config.app, `dist-recents-stage-${stamp}`);
const backup = path.join(config.app, `dist-before-recents-${stamp}`);
assert(!fs.existsSync(staging) && !fs.existsSync(backup));
const sourceFiles = manifest(source);
const packageBytes = fs.readFileSync(path.join(config.app, 'package.json'));
const cliSourceArg = process.argv.find(arg => arg.startsWith('--cli-history-source='));
const cliSource = cliSourceArg ? path.resolve(cliSourceArg.slice('--cli-history-source='.length)) : null;
const cliScopeSourceArg = process.argv.find(arg => arg.startsWith('--cli-scope-source='));
const cliScopeSource = cliScopeSourceArg ? path.resolve(cliScopeSourceArg.slice('--cli-scope-source='.length)) : null;
const cliPalSourceArg = process.argv.find(arg => arg.startsWith('--cli-pal-source='));
const cliPalSource = cliPalSourceArg ? path.resolve(cliPalSourceArg.slice('--cli-pal-source='.length)) : null;
assert((!cliScopeSource && !cliPalSource) || (cliSource && cliScopeSource && cliPalSource),
  'The reviewed scope and Pal modules must be staged together with the history host.');
const cliTarget = path.join(path.dirname(config.cli), 'commands', 'desktop-host.js');
const cliScopeTarget = path.join(path.dirname(config.cli), 'integrations', 'sessions', 'store.js');
const cliPalTarget = path.join(path.dirname(config.cli), 'pals', 'conversations.js');
const cliBefore = cliSource ? manifest(path.dirname(config.cli)) : null;
const cliPackagePath = path.join(path.dirname(path.dirname(config.cli)), 'package.json');
const cliPackageBytes = fs.readFileSync(cliPackagePath);
const cliSourceBytes = cliSource ? fs.readFileSync(cliSource) : null;
const cliScopeSourceBytes = cliScopeSource ? fs.readFileSync(cliScopeSource) : null;
const cliPalSourceBytes = cliPalSource ? fs.readFileSync(cliPalSource) : null;
const cliTargetBytes = cliSource ? fs.readFileSync(cliTarget) : null;
const cliScopeTargetBytes = cliScopeSource ? fs.readFileSync(cliScopeTarget) : null;
const cliPalTargetBytes = cliPalSource ? fs.readFileSync(cliPalTarget) : null;
const staticImports = bytes => {
  const code = bytes.toString('utf8');
  const imports = code.match(/^import[^\r\n]*;$/gm) ?? [];
  assert.equal(imports.length, (code.match(/^\s*import\s/gm) ?? []).length,
    'Unexpected or multiline static import declaration');
  return imports;
};
const exportLines = bytes => bytes.toString('utf8').match(/^export[^\r\n]*$/gm) ?? [];
const namedImport = (line, specifier) => {
  const match = line.match(/^import \{([^}]*)\} from '([^']+)';$/);
  assert(match && match[2] === specifier, `Expected named import from ${specifier}`);
  return match[1].split(',').map(name => name.trim()).filter(Boolean);
};
const exportNames = bytes => [...bytes.toString('utf8').matchAll(/^export (?:async )?(?:function|class|const|let|var) ([A-Za-z_$][\w$]*)/gm)]
  .map(match => match[1]);
if (cliSource) {
  assert.equal(path.basename(cliSource), 'desktop-host.js');
  assert.notEqual(cliSource.toLowerCase(), cliTarget.toLowerCase());
  assert(fs.statSync(cliTarget).isFile());
  const oldImports = staticImports(cliTargetBytes);
  const nextImports = staticImports(cliSourceBytes);
  assert.deepEqual(exportLines(cliSourceBytes), exportLines(cliTargetBytes),
    'CLI host exported declarations changed');
  if (!cliScopeSource) {
    assert.deepEqual(nextImports, oldImports, 'CLI module imports changed; stage a complete runtime instead');
  } else {
    const homeImport = "import { resolveNamzuHome } from '../integrations/state/home.js';";
    assert.equal(nextImports.filter(line => line === homeImport).length, 1,
      'Expected exactly one import of the existing home resolver');
    const comparedImports = nextImports.filter(line => line !== homeImport);
    assert.equal(comparedImports.length, oldImports.length, 'CLI host import count changed');
    const storeSpecifier = '../integrations/sessions/store.js';
    const trustSpecifier = '../integrations/trust/store.js';
    let storeImportCount = 0;
    let trustImportCount = 0;
    for (let index = 0; index < oldImports.length; index++) {
      const previous = oldImports[index];
      const next = comparedImports[index];
      if (!previous.endsWith(`from '${storeSpecifier}';`) &&
          !previous.endsWith(`from '${trustSpecifier}';`)) {
        assert.equal(next, previous, 'Unrelated CLI host import changed');
        continue;
      }
      const isStore = previous.endsWith(`from '${storeSpecifier}';`);
      if (isStore) storeImportCount++;
      else trustImportCount++;
      const specifier = isStore ? storeSpecifier : trustSpecifier;
      const addition = isStore ? 'openSessionScope' : 'isTrustedAtStateRoot';
      const previousNames = namedImport(previous, specifier);
      const nextNames = namedImport(next, specifier);
      assert(!previousNames.includes(addition), `Current host already imports ${addition}`);
      assert.equal(nextNames.filter(name => name === addition).length, 1);
      assert.deepEqual(nextNames.filter(name => name !== addition), previousNames,
        `CLI host ${specifier} import changed beyond ${addition}`);
    }
    assert.equal(storeImportCount, 1, 'Expected exactly one CLI store import');
    assert.equal(trustImportCount, 1, 'Expected exactly one CLI trust import');
    const homeTarget = fs.readFileSync(path.join(path.dirname(config.cli), 'integrations', 'state', 'home.js'), 'utf8');
    const trustTarget = fs.readFileSync(path.join(path.dirname(config.cli), 'integrations', 'trust', 'store.js'), 'utf8');
    assert(/^export \{[^}]*\bresolveNamzuHome\b[^}]*\} from '@namzu\/sdk';$/m.test(homeTarget),
      'The existing CLI home module does not re-export resolveNamzuHome');
    assert(/^export function isTrustedAtStateRoot\(/m.test(trustTarget),
      'The existing CLI trust module does not export isTrustedAtStateRoot');
  }
}
if (cliScopeSource) {
  assert.equal(path.basename(cliScopeSource), 'store.js');
  assert.notEqual(cliScopeSource.toLowerCase(), cliScopeTarget.toLowerCase());
  assert(fs.statSync(cliScopeTarget).isFile());
  assert.deepEqual(staticImports(cliScopeSourceBytes), staticImports(cliScopeTargetBytes),
    'CLI scope module imports changed; stage a complete runtime instead');
  const previousExports = exportNames(cliScopeTargetBytes);
  const nextExports = exportNames(cliScopeSourceBytes);
  assert(!previousExports.includes('openSessionScope'), 'Current store already exports the scope opener');
  assert.equal(nextExports.filter(name => name === 'openSessionScope').length, 1);
  assert.deepEqual(nextExports.filter(name => name !== 'openSessionScope'), previousExports,
    'CLI scope module exports changed beyond the reviewed opener');
  assert(/^export async function openSessionScope\(/m.test(cliScopeSourceBytes.toString('utf8')),
    'Reviewed scope opener export is missing');
  assert.deepEqual(exportLines(cliScopeSourceBytes).filter(line => !line.startsWith('export async function openSessionScope(')),
    exportLines(cliScopeTargetBytes), 'CLI scope module exported declarations changed beyond the opener');
}
if (cliPalSource) {
  assert.equal(path.basename(cliPalSource), 'conversations.js');
  assert.notEqual(cliPalSource.toLowerCase(), cliPalTarget.toLowerCase());
  assert(fs.statSync(cliPalTarget).isFile());
  assert.deepEqual(staticImports(cliPalSourceBytes), staticImports(cliPalTargetBytes),
    'CLI Pal module imports changed; stage a complete runtime instead');
  assert.deepEqual(exportLines(cliPalSourceBytes), exportLines(cliPalTargetBytes),
    'CLI Pal module exports changed');
}
const sdkPackagePath = cliSource ? fs.realpathSync(path.join(path.dirname(path.dirname(config.cli)), 'node_modules', '@namzu', 'sdk', 'package.json')) : null;
const sdkTarget = sdkPackagePath ? path.join(path.dirname(sdkPackagePath), 'dist') : null;
const sdkBefore = sdkTarget ? manifest(sdkTarget) : null;
const sdkPackageBytes = sdkPackagePath ? fs.readFileSync(sdkPackagePath) : null;
const portFile = path.join(process.env.APPDATA, 'Namzu', 'DevToolsActivePort');
const port = () => Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
const groups = node => !node ? [] : node.kind === 'group' ? [node] : [...groups(node.first), ...groups(node.second)];
let browser, page, before;
const receipt = { passed: false, nativeWindows: true, at: new Date().toISOString(), packageInstalls: 0,
  sdkCopies: 0, cliModuleCopies: 0, modelRequests: 0, computerActions: 0, sourceFiles: sourceFiles.length,
  sourceManifestSha256: hash(sourceFiles), backupDirectory: path.basename(backup), phase: 'preflight', checks: [] };
async function attach() {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port()}`);
  page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === new URL(config.url).href);
  assert(page, 'Exact native desktop page missing');
  page.setDefaultTimeout(60_000);
}
async function readState() {
	return page.evaluate(async () => {
		const api = window.namzu;
		if (!api) throw new Error('Native preload API is missing.');
		const workspace = await api.workspace();
		const currentWindow = workspace.layout.windows.find((item) => item.id === workspace.windowId);
		if (!currentWindow) throw new Error('Current window has no workspace.');
		const visit = (node) =>
			!node ? [] : node.kind === 'group' ? [node] : [...visit(node.first), ...visit(node.second)];
		const groups = visit(currentWindow.root);
		const projects = await api.projects();
		const catalogues = await Promise.all(
			projects.filter((item) => item.status === 'ready').map(async (item) => ({
				projectId: item.id,
				rows: await api.conversations(item.id),
			})),
		);
		const conversations = catalogues.flatMap((item) => item.rows);
		const profiles = await api.pals();
		const computers = await Promise.all(
			profiles.map(async (profile) => {
				const computer = await api.palComputer(profile.id);
				if (computer.control?.mode === 'transitioning')
					throw new Error('Pal computer control is transitioning.');
				return {
					id: profile.id,
					status: computer.status,
					generation: computer.generation,
					environmentId: computer.environmentId,
					control: computer.control,
				};
			}),
		);
		const sessions = [];
		for (const group of groups) for (const id of group.tabs) {
			const view = conversations.find((item) => item.id === id);
			if (!view) throw new Error('Open tab is absent from its project catalogue.');
			let history = await api.openConversation(view.projectId, id);
			if (api.readyConversation) {
				await api.readyConversation(view.projectId, id);
				history = await api.openConversation(view.projectId, id);
			}
			const thread = history.thread;
			if (
				thread?.running || thread?.responding || thread?.permissions?.length ||
				thread?.queuedItems?.length || thread?.queued?.length || thread?.activeToolIds?.length ||
				thread?.retry?.status === 'running'
			) throw new Error('An open conversation has active, queued, or permission work.');
			const jobs = await api.jobs(id);
			if (!Array.isArray(jobs) || jobs.some((job) => job.status === 'running' || job.recoveryRequired))
				throw new Error('An open conversation has active or recovery work.');
			const draft = await api.draft(id);
			const editor = [...document.querySelectorAll('.composer-input textarea[aria-label="Message Namzu"]')]
				.find((input) => input.closest('[data-workspace-group]')?.dataset.workspaceGroup === group.id);
			if (group.activeTabId === id && (!editor || editor.value !== draft))
				throw new Error('The visible composer is missing or differs from its saved draft.');
			sessions.push({
				id,
				projectId: view.projectId,
				messages: history.messages,
				partial: history.partial,
				thread,
				jobs,
				draft,
				settings: await api.draftSettings(id),
				attachments: await api.attachments(id),
				provider: (await api.providers(view.projectId, id)).selected,
			});
		}
		const sidebar = document.querySelector('#namzu-sidebar');
		const scroll = sidebar?.querySelector('.sidebar-scroll');
		const focusedGroup = groups.find((item) => item.id === currentWindow.focusedGroupId);
		const pane = [...document.querySelectorAll('[data-workspace-group]')]
			.find((item) => item.dataset.workspaceGroup === focusedGroup?.id);
		const transcript = pane?.querySelector('.transcript');
		const visible = (selector) => [...document.querySelectorAll(selector)]
			.some((item) => item.getClientRects().length > 0);
		if (
			visible('[role="dialog"], [role="alert"]') ||
			visible('.pal-computer-view canvas') ||
			document.activeElement?.closest?.('.pal-computer-view') ||
			(document.activeElement?.matches?.('textarea,input,[contenteditable="true"]') &&
				(document.activeElement.value?.length || document.activeElement.isContentEditable))
		) throw new Error('A dialog, alert, computer canvas, or focused editor is active.');
		if (!sidebar || sidebar.inert || !scroll || !focusedGroup || !transcript)
			throw new Error('Recents or the focused conversation is not available for navigation.');
		const presentations = Object.keys(localStorage)
			.filter((key) => key.startsWith('namzu.workspace.presentation:'))
			.sort().map((key) => [key, localStorage.getItem(key)]);
		const recents = [...document.querySelectorAll('.sidebar-recent-list [data-thread-item]')]
			.map((item) => ({ id: item.dataset.sessionId, rect: item.getBoundingClientRect() }))
			.filter((item) => item.rect.width > 0 && item.rect.y >= 0 && item.rect.bottom <= innerHeight)
			.map((item) => item.id);
		return {
			workspace, groups, projects, catalogues, profiles, computers, sessions, recents,
			dom: {
			page: document.querySelector('.workspace')?.dataset.page,
			focusedGroupId: focusedGroup.id,
			activeTabId: focusedGroup.activeTabId,
			sidebarScrollTop: scroll.scrollTop,
			sidebarCollapsed: document.querySelector('.workspace-host')?.dataset.sidebarCollapsed,
			projectDisclosure: [...sidebar.querySelectorAll('.sidebar-project-navigation [aria-expanded]')]
				.map((item) => [item.getAttribute('aria-label'), item.getAttribute('aria-expanded')]),
			recentDisclosure: [...sidebar.querySelectorAll('.sidebar-recent-list [aria-expanded]')]
				.map((item) => [item.getAttribute('aria-label'), item.getAttribute('aria-expanded')]),
			transcriptScrollTop: transcript.scrollTop,
			transcriptScrollRange: transcript.scrollHeight - transcript.clientHeight,
			selectedRecentId: sidebar.querySelector('.sidebar-recent-list [aria-current="page"]')
				?.closest('[data-thread-item]')?.dataset.sessionId ?? null,
			presentations,
			appearance: localStorage.getItem('namzu.appearance'),
			collapsedPreference: localStorage.getItem('namzu.sidebar-collapsed'),
			focusedElement: document.activeElement?.tagName ?? null,
		},
		};
	});
}

function semantic(state) {
  return {
    // Canonical identities can be regenerated on restart; placement and focus cannot.
    groups: state.groups.map(item => ({ tabs: item.tabs, active: item.activeTabId,
      focused: item.id === state.dom.focusedGroupId })),
    catalogues: [...state.catalogues].sort((a,b) => a.projectId.localeCompare(b.projectId)).map(item => ({ projectId: item.projectId, rows: [...item.rows].sort((a,b) => a.id.localeCompare(b.id)).map(row => ({
      id: row.id, projectId: row.projectId, title: row.title, updatedAt: row.updatedAt,
      palId: row.palId, palGreeting: row.palGreeting, harness: row.harness ?? 'namzu' })) })),
    profiles: [...state.profiles].sort((a,b) => a.id.localeCompare(b.id)), computers: [...state.computers].sort((a,b) => a.id.localeCompare(b.id)),
    projects: [...state.projects].sort((a,b) => a.id.localeCompare(b.id)).map(item => ({ id: item.id, trusted: item.trusted, status: item.status, path: item.path, palId: item.palId })),
    presentation: {
      // Graceful close flushes the active presentation; other saved views must remain byte exact.
      entries: state.dom.presentations.filter(([key]) => key !== `namzu.workspace.presentation:${state.dom.activeTabId}`),
      appearance: state.dom.appearance, sidebar: state.dom.collapsedPreference, page: state.dom.page,
      sidebarCollapsed: state.dom.sidebarCollapsed,
      // Followed transcripts retain the distance to their end as the restored content reflows.
      transcriptTailDistance: Math.max(0, state.dom.transcriptScrollRange - state.dom.transcriptScrollTop) },
    sessions: state.sessions.map(item => ({ id: item.id, messages: item.messages.map(({messageId, status, stopReason, ...body}) => body), partial: item.partial,
      jobs: item.jobs, draft: item.draft, settings: item.settings, attachments: item.attachments,
      provider: { id: item.settings?.choice?.provider ?? item.provider?.id, model: item.settings?.choice?.model ?? item.provider?.model }, tasks: item.thread?.tasks ?? [], tasksNotice: item.thread?.tasksNotice,
      retry: item.thread?.retry, retryNotice: item.thread?.retryNotice })),
  };
}
function digests(state) { return Object.fromEntries(Object.entries(semantic(state)).map(([name, value]) => [name, hash(value)])); }
(async () => {
  try {
    await attach();
    if (process.argv.includes('--verify-current')) {
      const previous = JSON.parse(fs.readFileSync(output, 'utf8'));
      assert(previous.privateSnapshot && path.basename(previous.privateSnapshot) === previous.privateSnapshot);
      before = JSON.parse(fs.readFileSync(path.join(root, previous.privateSnapshot), 'utf8'));
      await readState(); // Read-only computer presence may hydrate its local Pal connection.
      const after = await readState();
      receipt.beforePid = previous.beforePid;
      receipt.afterPid = Number(fs.readFileSync(path.join(root, 'desktop.pid'), 'utf8').trim());
      receipt.before = digests(before); receipt.after = digests(after);
      assert.deepEqual(receipt.after, receipt.before, 'Protected durable/display state differs');
      assert.deepEqual(manifest(target), sourceFiles);
      assert.equal(hash(fs.readFileSync(configPath)), hash(configBytes));
      assert.equal(hash(fs.readFileSync(path.join(config.app, 'package.json'))), hash(packageBytes));
      if (previous.cliManifestAfterSha256) {
        assert.equal(hash(manifest(path.dirname(config.cli))), previous.cliManifestAfterSha256,
          'Reviewed CLI runtime changed after activation');
        assert.equal(hash(fs.readFileSync(cliPackagePath)), previous.cliPackageSha256);
        const runtimeSdkPackage = fs.realpathSync(path.join(path.dirname(path.dirname(config.cli)),
          'node_modules', '@namzu', 'sdk', 'package.json'));
        assert.equal(hash(fs.readFileSync(runtimeSdkPackage)), previous.sdkPackageSha256);
        assert.equal(hash(manifest(path.join(path.dirname(runtimeSdkPackage), 'dist'))),
          previous.sdkManifestAfterSha256, 'SDK runtime changed after activation');
      }
      receipt.checks = [...previous.checks, 'fresh exact main/preload/renderer bytes',
        'original tab order, authored message bodies, drafts, files, selected model/settings, tasks, profiles and computers preserved'];
      receipt.sourceBytesMatch = true;
      receipt.normalization = { projectAndCatalogueOrder: 'canonical ID order', assistantTransportFields: ['messageId','status','stopReason'],
        provider: 'effective captured draft model overrides unspecified runtime default', scroll: 'distance to transcript end after content reflow',
        activePresentation: 'graceful close flushes current view', palConnections: 'read-only presence may hydrate local connection before second snapshot' };
      receipt.observedScroll = { before: before.dom.transcriptScrollTop, after: after.dom.transcriptScrollTop,
        beforeRange: before.dom.transcriptScrollRange, afterRange: after.dom.transcriptScrollRange };
      receipt.privateSnapshot = previous.privateSnapshot;
      receipt.backupDirectory = previous.backupDirectory;
      receipt.previousActivationPassed = previous.passed;
      receipt.originalActivationAt = previous.at;
      receipt.passed = true;
      return;
    }
    before = await readState();
    assert.equal(before.workspace.layout.windows.length, 1);
    assert.equal(before.groups.length, 1);
    assert(!before.workspace.pendingTransfer && !before.workspace.outgoingTransfer && !before.workspace.closingWindow);
    const oldPid = Number(fs.readFileSync(path.join(root, 'desktop.pid'), 'utf8').trim());
    process.kill(oldPid, 0);
    receipt.beforePid = oldPid; receipt.before = digests(before);
    const privateSnapshot = path.join(root, `recents-before-private-${stamp}.json`);
    fs.writeFileSync(privateSnapshot, JSON.stringify(before), { mode: 0o600 });
    receipt.privateSnapshot = path.basename(privateSnapshot);
    if (cliSource) {
      fs.writeFileSync(path.join(root, `cli-history-before-${stamp}.js`), fs.readFileSync(cliTarget), { mode: 0o600, flag: 'wx' });
      receipt.cliHistoryBeforeSha256 = hash(fs.readFileSync(cliTarget));
      receipt.cliHistoryAfterSha256 = hash(cliSourceBytes);
      receipt.cliHistoryBackup = `cli-history-before-${stamp}.js`;
      receipt.cliManifestBeforeSha256 = hash(cliBefore);
      receipt.cliPackageSha256 = hash(cliPackageBytes);
      receipt.sdkManifestBeforeSha256 = hash(sdkBefore);
      receipt.sdkPackageSha256 = hash(sdkPackageBytes);
    }
    if (cliScopeSource) {
      fs.writeFileSync(path.join(root, `cli-scope-before-${stamp}.js`), cliScopeTargetBytes,
        { mode: 0o600, flag: 'wx' });
      receipt.cliScopeBeforeSha256 = hash(cliScopeTargetBytes);
      receipt.cliScopeAfterSha256 = hash(cliScopeSourceBytes);
      receipt.cliScopeBackup = `cli-scope-before-${stamp}.js`;
    }
    if (cliPalSource) {
      fs.writeFileSync(path.join(root, `cli-pal-before-${stamp}.js`), cliPalTargetBytes,
        { mode: 0o600, flag: 'wx' });
      receipt.cliPalBeforeSha256 = hash(cliPalTargetBytes);
      receipt.cliPalAfterSha256 = hash(cliPalSourceBytes);
      receipt.cliPalBackup = `cli-pal-before-${stamp}.js`;
    }
    fs.cpSync(source, staging, { recursive: true, errorOnExist: true, force: false });
    assert.deepEqual(manifest(staging), sourceFiles);
    const finalState = await readState();
    assert.deepEqual(digests(finalState), receipt.before, 'State changed during staging');
    assert.equal(hash(finalState.workspace), hash(before.workspace));
    // Refuse activity/ownership changes between the full preflight and close.
    const last = await page.evaluate(async () => ({ workspace: await window.namzu.workspace(),
      editors: [...document.querySelectorAll('.composer-input textarea')].map(item => item.value),
      active: !!document.querySelector('.thread-running-indicator, .composer-approval-strip, .queued-messages') }));
    assert.equal(hash(last.workspace), hash(before.workspace));
    assert(!last.active, 'New work appeared after preflight');
    assert.deepEqual(last.editors, [before.sessions.find(item => item.id === before.dom.activeTabId).draft]);
    assert.equal(Number(fs.readFileSync(path.join(root, 'desktop.pid'), 'utf8').trim()), oldPid);
    assert.equal(hash(fs.readFileSync(configPath)), hash(configBytes));
    if (cliSource) {
      assert.deepEqual(manifest(path.dirname(config.cli)), cliBefore, 'CLI files changed during preflight');
      assert.deepEqual(manifest(sdkTarget), sdkBefore, 'SDK files changed during preflight');
      assert.equal(hash(fs.readFileSync(sdkPackagePath)), hash(sdkPackageBytes));
    }
    const oldPortStamp = fs.existsSync(portFile) ? fs.statSync(portFile).mtimeMs : null;
    receipt.phase = 'graceful-close';
    const close = cp.spawnSync(process.execPath, [path.join(root, 'close-current.cjs')], { encoding: 'utf8', windowsHide: true });
    receipt.close = { status: close.status, signal: close.signal, stdout: close.stdout ?? '',
      stderr: close.stderr ?? '', ...(close.error ? { error: close.error.message } : {}) };
    assert.equal(close.status, 0, 'Graceful owned close failed');
    let alive = true; try { process.kill(oldPid, 0); } catch { alive = false; }
    assert(!alive, 'Old desktop is still alive');
    try { await browser.close(); } catch {}
    browser = null;
    receipt.phase = 'deploy';
    fs.renameSync(target, backup);
    try { fs.renameSync(staging, target); } catch (error) {
      if (!fs.existsSync(target)) { fs.renameSync(backup, target); receipt.stageRollback = true; }
      throw error;
    }
    assert.deepEqual(manifest(target), sourceFiles);
    if (cliSource) {
      const modules = [
        { target: cliTarget, bytes: cliSourceBytes, before: cliTargetBytes },
        ...(cliScopeSource ? [{ target: cliScopeTarget, bytes: cliScopeSourceBytes,
          before: cliScopeTargetBytes }] : []),
        ...(cliPalSource ? [{ target: cliPalTarget, bytes: cliPalSourceBytes,
          before: cliPalTargetBytes }] : []),
      ].map(item => ({ ...item, staged: `${item.target}.recents-stage-${stamp}` }));
      const replaced = [];
      try {
        for (const item of modules) {
          fs.writeFileSync(item.staged, item.bytes, { flag: 'wx' });
          assert.equal(hash(fs.readFileSync(item.staged)), hash(item.bytes));
        }
        for (const item of modules) {
          fs.renameSync(item.staged, item.target);
          replaced.push(item);
          receipt.cliModuleCopies++;
        }
      } catch (error) {
        const copied = replaced.length;
        for (const item of replaced.reverse()) {
          const restore = `${item.target}.recents-restore-${stamp}`;
          fs.writeFileSync(restore, item.before, { flag: 'wx' });
          fs.renameSync(restore, item.target);
        }
        for (const item of modules) if (fs.existsSync(item.staged)) fs.unlinkSync(item.staged);
        receipt.cliModuleRollback = copied > 0;
        receipt.cliModuleCopies = 0;
        throw error;
      }
      receipt.checks.push(`reviewed ${modules.length} CLI module(s) staged after graceful close`);
    }
    receipt.checks.push('staged complete built desktop and retained old dist as backup');
    receipt.phase = 'startup';
    let watcher, timer, poll;
    const newPort = new Promise((resolve, reject) => {
      const finish = error => { watcher?.close(); clearTimeout(timer); clearInterval(poll); error ? reject(error) : resolve(); };
      const probe = async () => {
        try {
          if (!fs.existsSync(portFile) || fs.statSync(portFile).mtimeMs === oldPortStamp || !Number.isInteger(port()) || port() < 1) return;
          const pages = await fetch(`http://127.0.0.1:${port()}/json/list`, { signal: AbortSignal.timeout(2000) }).then(response => response.json());
          if (pages.some(item => item.url === new URL(config.url).href)) finish();
        } catch {}
      };
      watcher = fs.watch(path.dirname(portFile), () => { void probe(); });
      // Operational startup deadline, never used as a performance test outcome.
      timer = setTimeout(() => finish(Error('Native desktop startup did not expose its CDP page')), 60_000);
      const launch = cp.spawnSync(process.execPath, [path.join(root, 'launch.cjs')], { encoding: 'utf8', windowsHide: true });
      if (launch.status !== 0) { finish(Error('Native launcher failed')); return; }
      poll = setInterval(() => { void probe(); }, 250);
      void probe();
    });
    await newPort;
    await attach();
    await page.waitForFunction(async ids => {
      const projects = await window.namzu.projects();
      return ids.every(id => projects.some(item => item.id === id && item.status === 'ready'));
    }, before.projects.filter(item => item.status === 'ready').map(item => item.id), { timeout: 60_000 });
    await page.waitForFunction(expected => {
      const ids = [...document.querySelectorAll('.conversation-tab[data-tab-id]')].map(item => item.dataset.tabId);
      const active = document.querySelector('.conversation-tab[data-active="true"]')?.dataset.tabId;
      const editor = document.querySelector('.composer-input textarea[aria-label="Message Namzu"]');
      return JSON.stringify(ids) === JSON.stringify(expected.tabs) && active === expected.active && editor && !editor.disabled && !editor.readOnly;
    }, { tabs: before.groups[0].tabs, active: before.groups[0].activeTabId }, { timeout: 60_000 });
    await readState(); // Hydrate missing read-only Pal presence connections before comparing catalogues.
    receipt.phase = 'verify';
    const after = await readState();
    receipt.after = digests(after);
    receipt.activePresentation = { before: hash(before.dom.presentations.find(([key]) => key === `namzu.workspace.presentation:${before.dom.activeTabId}`) ?? null),
      after: hash(after.dom.presentations.find(([key]) => key === `namzu.workspace.presentation:${after.dom.activeTabId}`) ?? null),
      rule: 'Graceful close may flush the active view; other presentation entries and visible page/scroll/preferences are protected.' };
    fs.writeFileSync(path.join(root, `recents-after-private-${stamp}.json`), JSON.stringify(after), { mode: 0o600 });
    for (const key of Object.keys(receipt.before)) assert.equal(receipt.after[key], receipt.before[key], `Protected ${key} changed across activation`);
    assert.equal(hash(fs.readFileSync(configPath)), hash(configBytes));
    assert.equal(hash(fs.readFileSync(path.join(config.app, 'package.json'))), hash(packageBytes));
    assert.deepEqual(manifest(target), sourceFiles);
    if (cliSource) {
      const expectedCli = cliBefore.map(item => item.file === 'commands/desktop-host.js'
        ? { ...item, hash: hash(cliSourceBytes) }
        : item.file === 'integrations/sessions/store.js' && cliScopeSource
          ? { ...item, hash: hash(cliScopeSourceBytes) }
          : item.file === 'pals/conversations.js' && cliPalSource
            ? { ...item, hash: hash(cliPalSourceBytes) }
          : item);
      assert.deepEqual(manifest(path.dirname(config.cli)), expectedCli, 'Unrelated CLI files changed');
      assert.deepEqual(manifest(sdkTarget), sdkBefore, 'SDK files changed');
      assert.equal(hash(fs.readFileSync(sdkPackagePath)), hash(sdkPackageBytes));
      assert.equal(hash(fs.readFileSync(cliPackagePath)), hash(cliPackageBytes));
      receipt.cliManifestAfterSha256 = hash(expectedCli);
      receipt.sdkManifestAfterSha256 = hash(sdkBefore);
    }
    receipt.afterPid = Number(fs.readFileSync(path.join(root, 'desktop.pid'), 'utf8').trim());
    assert.notEqual(receipt.afterPid, oldPid);
    receipt.sourceBytesMatch = true;
    receipt.computerStates = after.computers.map(item => ({ id: item.id, status: item.status, generation: item.generation }));
    receipt.checks.push('fresh desktop main/preload/renderer', 'original tab order and active conversation restored',
      'messages, drafts, model/settings, files, tasks, profiles and computers preserved', 'launch and dependency graph unchanged');
    receipt.phase = 'complete';
    receipt.passed = true;
  } catch (error) { receipt.error = { name: error.name, message: error.message }; process.exitCode = 1; }
  finally {
    if (browser) { try { await browser.close(); } catch {} }
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ passed: receipt.passed, beforePid: receipt.beforePid, afterPid: receipt.afterPid, checks: receipt.checks.length, error: receipt.error ? 'See private activation receipt' : undefined }));
  }
})();
