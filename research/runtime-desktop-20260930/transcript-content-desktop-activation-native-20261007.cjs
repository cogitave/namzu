'use strict';
// Bounded transcript-content activation. Native Windows Node; no installs.
// <script> <built desktop dist> <fresh private receipt.json>
//   --cli-history-source=<built CLI commands/desktop-host.js>
//   --cli-store-source=<built CLI pals/store.js>
//   --cli-environment-source=<built CLI pals/environment.js>
//   --cli-codex-source=<built CLI integrations/harness/codex-adapter.js>
//   --cli-native-archive-source=<built CLI commands/acp-harness.js>
//   --cli-pal-scope-source=<built CLI integrations/sessions/store.js>
//   --cli-claude-protocol-source=<built CLI integrations/harness/claude-protocol.js>
//   --sdk-pal-store-source=<built SDK pals/store.js>
//   --prepare-only | --apply-reviewed | --verify-current --verify-from=<original receipt>
// Review all eight runtime modules; only desktop-host.js, claude-protocol.js and
// integrations/sessions/store.js may change. Existing graph/junctions and every
// other CLI/SDK file remain byte exact. Original helpers and receipts are retained.
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
const verifyFromArgs = process.argv.filter(arg => arg.startsWith('--verify-from='));
assert(verifyFromArgs.length <= 1, 'Repeated verification receipt option');
const verifyFrom = verifyFromArgs.length ? path.resolve(verifyFromArgs[0].slice('--verify-from='.length)) : null;
function assertConfinedFile(file) {
  const realRoot = fs.realpathSync(root);
  const fileRelative = path.relative(realRoot, fs.realpathSync(file));
  assert(fileRelative && !fileRelative.startsWith('..') && !path.isAbsolute(fileRelative),
    'Verification input must remain inside the private Development directory');
  assert(fs.statSync(file).isFile(), 'Verification input must be a file');
}
if (verifyFrom) {
  assert(process.argv.includes('--verify-current'), '--verify-from requires read-only --verify-current');
  assertConfinedFile(verifyFrom);
  assert.notEqual(verifyFrom.toLowerCase(), output.toLowerCase(), 'The original receipt must be retained');
  assert(!fs.existsSync(output), 'Read-only verification requires a fresh output receipt');
  const outputParent = path.relative(fs.realpathSync(root), fs.realpathSync(path.dirname(output)));
  assert(!outputParent.startsWith('..') && !path.isAbsolute(outputParent), 'Verification output must remain private');
}
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
const staging = path.join(config.app, `dist-removal-stage-${stamp}`);
const backup = path.join(config.app, `dist-before-removal-${stamp}`);
assert(!fs.existsSync(staging) && !fs.existsSync(backup));
for (const flag of ['--prepare-only', '--apply-reviewed', '--verify-current'])
  assert(process.argv.filter(arg => arg === flag).length <= 1, `Repeated operation mode ${flag}`);
const modes = ['--prepare-only', '--apply-reviewed', '--verify-current'].filter(mode => process.argv.includes(mode));
assert.equal(modes.length, 1, 'Select one explicit operation mode; there is no default apply.');
const mode = modes[0];
assert(!fs.existsSync(output), 'Each invocation requires a fresh private receipt; preserve previous evidence.');
const sourceFiles = manifest(source);
const packageBytes = fs.readFileSync(path.join(config.app, 'package.json'));
const cliPackagePath = path.join(path.dirname(path.dirname(config.cli)), 'package.json');
const cliPackageBytes = fs.readFileSync(cliPackagePath);
const cliRoot = path.dirname(config.cli);
const sdkPackagePath = fs.realpathSync(path.join(path.dirname(path.dirname(config.cli)), 'node_modules', '@namzu', 'sdk', 'package.json'));
const sdkTarget = path.join(path.dirname(sdkPackagePath), 'dist');
const sdkPackageBytes = fs.readFileSync(sdkPackagePath);
const cliBefore = manifest(cliRoot);
const sdkBefore = manifest(sdkTarget);
const sourceOptions = [
  { option: '--cli-history-source=', kind: 'cli', file: 'commands/desktop-host.js', label: 'History',
    additions: new Map([
      ['@namzu/sdk', ['selectAssistantText']],
      ['node:fs/promises', ['lstat']],
      ['../integrations/sessions/store.js', ['archiveConversation', 'loadConversationSnapshot']],
      ['../pals/environment.js', ['existingCliPalRuntime']],
      ['../pals/store.js', ['deletePal']],
    ]), addedExports: [] },
  { option: '--cli-store-source=', kind: 'cli', file: 'pals/store.js', label: 'PalStore',
    additions: new Map(), addedExports: ['deletePal'] },
  { option: '--cli-environment-source=', kind: 'cli', file: 'pals/environment.js', label: 'PalEnvironment',
    additions: new Map(), addedExports: ['existingCliPalRuntime'] },
  { option: '--cli-codex-source=', kind: 'cli', file: 'integrations/harness/codex-adapter.js', label: 'CodexCapabilities',
    additions: new Map(), addedExports: [] },
  { option: '--cli-native-archive-source=', kind: 'cli', file: 'commands/acp-harness.js', label: 'IdleNativeArchive',
    additions: new Map([['../integrations/trust/store.js', ['isTrustedAtStateRoot']]]),
    allowedAbsentImports: new Set(['../integrations/trust/store.js']), addedExports: [] },
  { option: '--cli-pal-scope-source=', kind: 'cli', file: 'integrations/sessions/store.js', label: 'VerifiedPalScope',
    additions: new Map([['node:fs', ['lstatSync']], ['node:fs/promises', ['lstat']]]), addedExports: ['loadConversationSnapshot'] },
  { option: '--cli-claude-protocol-source=', kind: 'cli', file: 'integrations/harness/claude-protocol.js', label: 'ClaudeInterruptedTranscript',
    additions: new Map(), addedExports: [] },
  { option: '--sdk-pal-store-source=', kind: 'sdk', file: 'pals/store.js', label: 'PalStore',
    additions: new Map(), addedExports: [] },
];
const validFlags = new Set([...sourceOptions.map(item => item.option), '--verify-from=', ...modes]);
for (const arg of process.argv.slice(4)) assert([...validFlags].some(flag => flag.endsWith('=') ? arg.startsWith(flag) : arg === flag), `Unknown activation option ${arg}`);
const runtimeStagingDirectory = path.join(root, `removal-runtime-stage-${stamp}`);
const runtimeModules = sourceOptions.map(item => {
  const args = process.argv.filter(arg => arg.startsWith(item.option));
  assert.equal(args.length, 1, `Supply exactly one reviewed ${item.option} source.`);
  const provided = path.resolve(args[0].slice(item.option.length));
  const target = path.join(item.kind === 'cli' ? cliRoot : sdkTarget, item.file);
  assert.equal(path.basename(provided), path.basename(target));
  for (const file of [provided, target]) {
    const entry = fs.lstatSync(file);
    assert(entry.isFile() && !entry.isSymbolicLink(), 'Reviewed module must be a regular non-link file.');
  }
  assert.notEqual(fs.realpathSync(provided).toLowerCase(), fs.realpathSync(target).toLowerCase());
  assert((item.kind === 'cli' ? cliBefore : sdkBefore).some(row => row.file === item.file), 'Reviewed module is absent from the installed payload.');
  const syntax = cp.spawnSync(process.execPath, ['--check', provided], { encoding: 'utf8', windowsHide: true });
  assert.equal(syntax.status, 0, `Reviewed source syntax check failed for ${item.kind}/${item.file}.`);
  return { ...item, source: provided, target, bytes: fs.readFileSync(provided), before: fs.readFileSync(target),
    staged: path.join(runtimeStagingDirectory, item.kind, item.file) };
});
const cliModules = runtimeModules.filter(item => item.kind === 'cli');
const sdkModules = runtimeModules.filter(item => item.kind === 'sdk');
const expectedChangedRuntimeSet = [
  'cli/commands/desktop-host.js',
  'cli/integrations/harness/claude-protocol.js',
  'cli/integrations/sessions/store.js',
];
const changedRuntimeModules = runtimeModules.filter(item => hash(item.before) !== hash(item.bytes));
assert.deepEqual(changedRuntimeModules.map(item => `${item.kind}/${item.file}`).sort(),
  mode === '--verify-current' ? [] : expectedChangedRuntimeSet,
  'The changed runtime set differs from the exact reviewed transcript update.');
const cliSource = cliModules.find(item => item.label === 'History').source;
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
const hasNamedExport = (bytes, name) => exportNames(bytes).includes(name) ||
  [...bytes.toString('utf8').matchAll(/^export \{([^}]*)\}(?: from '[^']+')?;$/gm)]
    .some(match => match[1].split(',').map(part => part.trim().split(/\s+as\s+/).at(-1)).includes(name));
for (const item of runtimeModules) {
  const previousImports = staticImports(item.before);
  const nextImports = staticImports(item.bytes);
  const additionFor = line => [...item.additions.keys()].find(specifier => line.endsWith(`from '${specifier}';`));
  assert.deepEqual(nextImports.filter(line => !additionFor(line)), previousImports.filter(line => !additionFor(line)),
    `Unreviewed ${item.kind}/${item.file} import changed.`);
  for (const [specifier, additions] of item.additions) {
    const previous = previousImports.filter(line => line.endsWith(`from '${specifier}';`));
    const next = nextImports.filter(line => line.endsWith(`from '${specifier}';`));
    if (specifier === 'node:fs/promises' || item.allowedAbsentImports?.has(specifier)) assert(previous.length <= 1);
    else assert.equal(previous.length, 1);
    assert.equal(next.length, 1);
    const previousNames = previous.length ? namedImport(previous[0], specifier) : [];
    const nextNames = namedImport(next[0], specifier);
    assert.deepEqual(nextNames.filter(name => !additions.includes(name)), previousNames.filter(name => !additions.includes(name)),
      `Import changed beyond reviewed additions in ${item.file}.`);
    let importedTarget;
    if (specifier === '@namzu/sdk') {
      // This one new bare import uses the existing, graph-validated SDK root.
      // Its exact public barrel route is checked without executing package code.
      assert.equal(item.kind, 'cli');
      assert.deepEqual(additions, ['selectAssistantText']);
      const sdkIndex = fs.readFileSync(path.join(sdkTarget, 'index.js'), 'utf8');
      assert(/^export \* from '\.\/public-runtime\.js';$/m.test(sdkIndex),
        'The installed SDK public-runtime export route changed.');
      importedTarget = path.join(sdkTarget, 'public-runtime.js');
    } else if (specifier.startsWith('node:')) importedTarget = null;
    else {
      assert(specifier.startsWith('.'), 'An unreviewed bare import cannot be resolved.');
      importedTarget = path.resolve(path.dirname(item.target), specifier);
    }
    const replacement = importedTarget && runtimeModules.find(candidate => candidate.target.toLowerCase() === importedTarget.toLowerCase());
    const importedBytes = importedTarget ? (replacement?.bytes ?? fs.readFileSync(importedTarget)) : null;
    for (const name of additions) {
      assert.equal(nextNames.filter(value => value === name).length, 1);
      if (importedBytes) assert(hasNamedExport(importedBytes, name), `Native module does not export reviewed ${name}.`);
      else assert.equal(typeof require(specifier)[name], 'function', `Node does not export reviewed ${name}.`);
    }
  }
  const unreviewedExports = bytes => exportLines(bytes).filter(line =>
    !item.addedExports.some(name => new RegExp(`^export (?:async )?function ${name}\\(`).test(line)));
  assert.deepEqual(unreviewedExports(item.bytes), unreviewedExports(item.before),
    `Export changed beyond reviewed additions in ${item.kind}/${item.file}.`);
  for (const name of item.addedExports) assert(hasNamedExport(item.bytes, name), `Reviewed export ${name} is absent.`);
}
assert(/^\s+delete\(id, expectedRevision\) \{/m.test(sdkModules[0].bytes.toString('utf8')),
  'Reviewed SDK DiskPalStore.delete implementation is absent.');
const runtimeRoot = path.join(root, 'runtime');
const graphPath = path.join(runtimeRoot, 'manifest.json');
const graphBytes = fs.readFileSync(graphPath);
const graph = JSON.parse(graphBytes);
assert(Array.isArray(graph.packages), 'Native package graph is missing.');
assert.equal(fs.realpathSync(path.join(runtimeRoot, graph.cli)).toLowerCase(), fs.realpathSync(config.cli).toLowerCase());
function packageGraph() {
  const sdkRoots = new Set(); let links = 0; let sdkUsers = 0;
  const packages = graph.packages.map(item => {
    const directory = path.join(runtimeRoot, item.relative);
    const packagePath = path.join(directory, 'package.json');
    const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    assert.equal(metadata.name, item.name); assert.equal(metadata.version, item.version);
    const rows = Object.entries(item.links ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, relative]) => {
      const actual = fs.realpathSync(path.join(directory, 'node_modules', name));
      const expected = fs.realpathSync(path.join(runtimeRoot, relative));
      assert.equal(actual.toLowerCase(), expected.toLowerCase(), `Installed mapping changed for ${item.name}/${name}.`);
      const linkedPackage = path.join(actual, 'package.json');
      assert.equal(JSON.parse(fs.readFileSync(linkedPackage, 'utf8')).name, name);
      links++;
      if (name === '@namzu/sdk') { sdkUsers++; sdkRoots.add(actual.toLowerCase()); }
      return { name, directory: actual, packageSha256: hash(fs.readFileSync(linkedPackage)) };
    });
    return { directory: fs.realpathSync(directory), name: metadata.name, packageSha256: hash(fs.readFileSync(packagePath)), links: rows };
  });
  assert.equal(links, 225, 'Unexpected dependency mapping count.');
  assert.equal(sdkUsers, 11, 'Unexpected SDK consumer count.');
  assert.equal(sdkRoots.size, 1, 'The runtime must retain one SDK root.');
  assert.equal([...sdkRoots][0], fs.realpathSync(path.dirname(sdkPackagePath)).toLowerCase());
  return { packages, links, sdkUsers, singleSdkRoot: true };
}
function dependencyGraph(packagePath) {
  const directory = path.dirname(packagePath);
  const dependencies = JSON.parse(fs.readFileSync(packagePath, 'utf8')).dependencies ?? {};
  return Object.keys(dependencies).sort().map(name => {
    const dependencyPackage = fs.realpathSync(path.join(directory, 'node_modules', name, 'package.json'));
    return { name, requested: dependencies[name], packagePath: dependencyPackage, packageSha256: hash(fs.readFileSync(dependencyPackage)) };
  });
}
const cliDependencyGraph = dependencyGraph(cliPackagePath);
const sdkDependencyGraph = dependencyGraph(sdkPackagePath);
const packageGraphBefore = packageGraph();
let runtimeStagingOwned = false;
function cleanupCliStaging() {
  if (!runtimeStagingOwned || !fs.existsSync(runtimeStagingDirectory)) return;
  const directories = new Set([runtimeStagingDirectory]);
  for (const item of runtimeModules) {
    if (fs.existsSync(item.staged)) fs.unlinkSync(item.staged);
    let directory = path.dirname(item.staged);
    while (directory !== runtimeStagingDirectory) { directories.add(directory); directory = path.dirname(directory); }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) if (fs.existsSync(directory)) fs.rmdirSync(directory);
}
function expectedPayload(before, modules) {
  return before.map(row => { const module = modules.find(item => item.file === row.file); return module ? { ...row, hash: hash(module.bytes) } : row; });
}
function protectGraph() {
  assert.equal(hash(fs.readFileSync(graphPath)), hash(graphBytes), 'Native graph manifest changed.');
  assert.deepEqual(packageGraph(), packageGraphBefore, 'Installed dependency graph changed.');
  assert.deepEqual(dependencyGraph(cliPackagePath), cliDependencyGraph, 'CLI dependencies changed.');
  assert.deepEqual(dependencyGraph(sdkPackagePath), sdkDependencyGraph, 'SDK dependencies changed.');
  assert.equal(hash(fs.readFileSync(cliPackagePath)), hash(cliPackageBytes));
  assert.equal(hash(fs.readFileSync(sdkPackagePath)), hash(sdkPackageBytes));
}
function ownedProcessInventory(mainPid) {
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const script = `$all = @(Get-CimInstance Win32_Process); $ids = [System.Collections.Generic.HashSet[int]]::new(); ` +
    `[void]$ids.Add(${mainPid}); do { $added = $false; foreach ($p in $all) { ` +
    `if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added = $true } } } while ($added); ` +
    `$rows = @($all | Where-Object { $ids.Contains([int]$_.ProcessId) -or ` +
    `($_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf(${quote(config.cli)}, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) } | ` +
    `ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; name = $_.Name; ` +
    `createdAt = $_.CreationDate.ToUniversalTime().ToString('o'); executable = $_.ExecutablePath; ` +
    `ownedDescendant = $ids.Contains([int]$_.ProcessId); ` +
    `currentCli = [bool]($_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf(${quote(config.cli)}, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) } }); ` +
    `ConvertTo-Json -InputObject $rows -Depth 3 -Compress`;
  const probe = cp.spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(probe.status, 0, 'Could not verify owned native processes.');
  const rows = JSON.parse(probe.stdout.trim());
  assert(Array.isArray(rows), 'Native process inventory must be an array.');
  return rows.sort((a, b) => a.pid - b.pid);
}
const portFile = path.join(process.env.APPDATA, 'Namzu', 'DevToolsActivePort');
const port = () => Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
const groups = node => !node ? [] : node.kind === 'group' ? [node] : [...groups(node.first), ...groups(node.second)];
let browser, page, before;
const receipt = { passed: false, nativeWindows: true, at: new Date().toISOString(), packageInstalls: 0,
  sdkCopies: 0, cliModuleCopies: 0, modelRequests: 0, computerActions: 0, sourceFiles: sourceFiles.length,
  sourceManifestSha256: hash(sourceFiles), launchConfigSha256: hash(configBytes),
  desktopPackageSha256: hash(packageBytes), backupDirectory: path.basename(backup), phase: 'preflight', checks: [] };
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
		const terminalAlerts = [...document.querySelectorAll('[role="alert"]')]
			.filter((item) => item.getClientRects().length > 0)
			.map((item) => {
				const groupId = item.closest('[data-workspace-group]')?.dataset.workspaceGroup;
				const group = groups.find((candidate) => candidate.id === groupId);
				const session = group && sessions.find((candidate) => candidate.id === group.activeTabId);
				const message = item.textContent?.trim() ?? '';
				if (
					!item.matches('.inline-error') || !item.closest('.transcript .conversation-body') ||
					!session || session.thread?.stopReason !== 'error' || session.thread.error !== message || !message
				) throw new Error('A visible alert is not the captured idle conversation’s exact terminal error.');
				return { sessionId: session.id, error: message };
			});
		if (
			visible('[role="dialog"], [role="alertdialog"]') ||
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
			terminalAlerts,
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
      const previousFile = verifyFrom ?? output;
      assertConfinedFile(previousFile);
      const previousBytes = fs.readFileSync(previousFile);
      const previous = JSON.parse(previousBytes.toString('utf8'));
      if (previous.passed !== true) assert(verifyFrom, 'A failed original receipt must be retained through --verify-from');
      assert(Array.isArray(previous.cliReviewedModules) && Array.isArray(previous.sdkReviewedModules),
        'The original reviewed runtime module sets are missing.');
      const previousChangedCli = previous.cliReviewedModules.filter(item => item.beforeSha256 !== item.afterSha256);
      const previousChangedSdk = previous.sdkReviewedModules.filter(item => item.beforeSha256 !== item.afterSha256);
      assert.deepEqual([
        ...previousChangedCli.map(item => `cli/${item.file}`),
        ...previousChangedSdk.map(item => `sdk/${item.file}`),
      ].sort(), expectedChangedRuntimeSet, 'The original changed runtime set differs from the exact transcript update.');
      const completedApplication = previous.phase === 'verify' &&
        Number.isInteger(previous.cliModuleCopies) && previous.cliModuleCopies > 0 &&
        previous.cliModuleCopies === previousChangedCli.length &&
        previous.cliReviewedModules.length === cliModules.length &&
        previous.sdkReviewedModules.length === sdkModules.length && previous.sdkCopies === previousChangedSdk.length;
      assert(previous.passed === true || completedApplication,
        'Verification requires a passed receipt or an entirely applied reviewed CLI update');
      assert.equal(previous.sourceManifestSha256, hash(sourceFiles), 'The reviewed desktop source differs from the original activation');
      if (previous.launchConfigSha256) assert.equal(hash(configBytes), previous.launchConfigSha256,
        'Launch configuration differs from the original activation');
      if (previous.desktopPackageSha256) assert.equal(hash(packageBytes), previous.desktopPackageSha256,
        'Desktop package differs from the original activation');
      assert(previous.privateSnapshot && path.basename(previous.privateSnapshot) === previous.privateSnapshot);
      const snapshot = path.join(root, previous.privateSnapshot);
      assertConfinedFile(snapshot);
      before = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
      assert.deepEqual(digests(before), previous.before, 'The original protected snapshot differs from its recorded digests');
      await readState(); // Read-only computer presence may hydrate its local Pal connection.
      const after = await readState();
      receipt.beforePid = previous.beforePid;
      receipt.afterPid = Number(fs.readFileSync(path.join(root, 'desktop.pid'), 'utf8').trim());
      receipt.before = digests(before); receipt.after = digests(after);
      if (previous.afterPid !== undefined) assert.equal(receipt.afterPid, previous.afterPid,
        'The current desktop is not the originally verified process');
      else assert.notEqual(receipt.afterPid, previous.beforePid, 'The original desktop did not restart');
      assert.deepEqual(receipt.after, receipt.before, 'Protected durable/display state differs');
      assert.deepEqual(manifest(target), sourceFiles);
      assert.equal(hash(fs.readFileSync(configPath)), hash(configBytes));
      assert.equal(hash(fs.readFileSync(path.join(config.app, 'package.json'))), hash(packageBytes));
      for (const [kind, modules, currentRoot] of [['cli', cliModules, cliRoot], ['sdk', sdkModules, sdkTarget]]) {
        const reviewed = previous[`${kind}ReviewedModules`];
        assert(Array.isArray(reviewed) && reviewed.length === modules.length, 'Original reviewed module set is incomplete.');
        const current = manifest(currentRoot); const seen = new Set();
        for (const item of reviewed) {
          assert(!seen.has(item.file)); seen.add(item.file);
          const provided = modules.find(module => module.file === item.file);
          assert(provided && /^[a-f0-9]{64}$/.test(item.beforeSha256));
          assert.equal(hash(provided.bytes), item.afterSha256, 'Reviewed module source changed.');
          assert.equal(current.find(row => row.file === item.file)?.hash, item.afterSha256, 'Applied module bytes changed.');
        }
        const reconstructed = current.map(row => { const item = reviewed.find(module => module.file === row.file); return item ? { ...row, hash: item.beforeSha256 } : row; });
        assert.equal(hash(reconstructed), previous[`${kind}ManifestBeforeSha256`], 'Unrelated runtime payload changed.');
        assert.equal(hash(current), previous[`${kind}ManifestAfterSha256`], 'Applied runtime manifest changed.');
        receipt[`${kind}ReviewedModules`] = reviewed;
        receipt[`${kind}ManifestBeforeSha256`] = previous[`${kind}ManifestBeforeSha256`];
        receipt[`${kind}ManifestAfterSha256`] = hash(current);
      }
      assert.equal(hash(cliPackageBytes), previous.cliPackageSha256);
      assert.equal(hash(sdkPackageBytes), previous.sdkPackageSha256);
      assert.equal(hash(cliDependencyGraph), previous.cliDependencyGraphSha256);
      assert.equal(hash(sdkDependencyGraph), previous.sdkDependencyGraphSha256);
      assert.equal(hash(graphBytes), previous.packageGraphManifestSha256);
      assert.equal(hash(packageGraphBefore), previous.packageGraphSha256);
      protectGraph();
      receipt.cliPackageSha256 = hash(cliPackageBytes); receipt.sdkPackageSha256 = hash(sdkPackageBytes);
      receipt.cliDependencyGraphSha256 = hash(cliDependencyGraph); receipt.sdkDependencyGraphSha256 = hash(sdkDependencyGraph);
      receipt.packageGraphManifestSha256 = hash(graphBytes); receipt.packageGraphSha256 = hash(packageGraphBefore);
      receipt.dependencyLinks = packageGraphBefore.links; receipt.sdkUsers = packageGraphBefore.sdkUsers;
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
      receipt.previousActivationPhase = previous.phase;
      receipt.originalCliModuleCopies = previous.originalCliModuleCopies ?? previous.cliModuleCopies;
      if (verifyFrom) {
        assert.equal(hash(fs.readFileSync(verifyFrom)), hash(previousBytes), 'The original receipt changed during verification');
        receipt.verificationFrom = path.basename(verifyFrom);
        receipt.verificationFromSha256 = hash(previousBytes);
      }
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
    receipt.terminalAlertsBefore = before.dom.terminalAlerts;
    receipt.terminalAlertRule = 'Only the captured idle active transcript’s exact thread.error is allowed; every other alert or dialog refuses activation. Process-local diagnostics are recorded separately from durable state.';
    receipt.beforeProcesses = ownedProcessInventory(oldPid);
    const mainProcess = receipt.beforeProcesses.find(item => item.pid === oldPid);
    assert(mainProcess && mainProcess.executable.toLowerCase() === config.electron.toLowerCase(), 'Main executable does not match the reviewed launcher.');
    assert(receipt.beforeProcesses.every(item => !item.currentCli || item.ownedDescendant), 'Another process is using the installed CLI payload.');
    const privateSnapshot = path.join(root, `removal-before-private-${stamp}.json`);
    fs.writeFileSync(privateSnapshot, JSON.stringify(before), { mode: 0o600 });
    receipt.privateSnapshot = path.basename(privateSnapshot);
    if (mode === '--prepare-only') {
      receipt.beforePid = oldPid; receipt.before = digests(before);
      receipt.cliReviewedModules = cliModules.map(item => ({ file: item.file, beforeSha256: hash(item.before), afterSha256: hash(item.bytes) }));
      receipt.sdkReviewedModules = sdkModules.map(item => ({ file: item.file, beforeSha256: hash(item.before), afterSha256: hash(item.bytes) }));
      receipt.packageGraphManifestSha256 = hash(graphBytes); receipt.packageGraphSha256 = hash(packageGraphBefore);
      receipt.dependencyLinks = packageGraphBefore.links; receipt.sdkUsers = packageGraphBefore.sdkUsers;
      protectGraph();
      assert.deepEqual(manifest(cliRoot), cliBefore); assert.deepEqual(manifest(sdkTarget), sdkBefore);
      receipt.checks = ['metadata preflight only', 'eight reviewed modules; only desktop-host, Claude protocol and session store may change', '225 dependency links and 11 users of one SDK root unchanged'];
      receipt.phase = 'prepared'; receipt.passed = true; return;
    }
    assert.equal(mode, '--apply-reviewed');
    assert(before.computers.every(computer => computer.status === 'stopped'), 'All Pal computers must be stopped before native restart.');
    if (cliSource) {
      receipt.cliManifestBeforeSha256 = hash(cliBefore);
      receipt.cliPackageSha256 = hash(cliPackageBytes);
      receipt.cliDependencyGraphSha256 = hash(cliDependencyGraph);
      receipt.sdkManifestBeforeSha256 = hash(sdkBefore);
      receipt.sdkPackageSha256 = hash(sdkPackageBytes);
      receipt.sdkDependencyGraphSha256 = hash(sdkDependencyGraph);
      receipt.packageGraphManifestSha256 = hash(graphBytes); receipt.packageGraphSha256 = hash(packageGraphBefore);
      receipt.dependencyLinks = packageGraphBefore.links; receipt.sdkUsers = packageGraphBefore.sdkUsers;
      assert(!fs.existsSync(runtimeStagingDirectory), 'Runtime staging directory already exists.');
      fs.mkdirSync(runtimeStagingDirectory, { mode: 0o700 }); runtimeStagingOwned = true;
      receipt.cliReviewedModules = []; receipt.sdkReviewedModules = [];
      for (const item of runtimeModules) {
        assert.equal(path.parse(item.target).root.toLowerCase(), path.parse(item.staged).root.toLowerCase());
        const backupName = `${item.kind}-${item.label.toLowerCase()}-before-${stamp}.js`;
        fs.writeFileSync(path.join(root, backupName), item.before, { mode: 0o600, flag: 'wx' });
        receipt[`${item.kind}${item.label}Backup`] = backupName;
        fs.mkdirSync(path.dirname(item.staged), { recursive: true, mode: 0o700 });
        fs.writeFileSync(item.staged, item.bytes, { mode: 0o600, flag: 'wx' });
        assert.equal(hash(fs.readFileSync(item.staged)), hash(item.bytes));
        receipt[`${item.kind}ReviewedModules`].push({ file: item.file, beforeSha256: hash(item.before), afterSha256: hash(item.bytes) });
      }
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
      assert.equal(hash(fs.readFileSync(cliPackagePath)), hash(cliPackageBytes));
      assert.deepEqual(dependencyGraph(cliPackagePath), cliDependencyGraph, 'CLI dependency mapping changed during preflight');
      assert.deepEqual(manifest(sdkTarget), sdkBefore, 'SDK files changed during preflight');
      assert.equal(hash(fs.readFileSync(sdkPackagePath)), hash(sdkPackageBytes));
      protectGraph();
      for (const item of runtimeModules) {
        assert.equal(hash(fs.readFileSync(item.source)), hash(item.bytes), 'Reviewed CLI source changed during preflight');
        assert.equal(hash(fs.readFileSync(item.staged)), hash(item.bytes), 'Staged CLI source changed during preflight');
      }
    }
    const oldPortStamp = fs.existsSync(portFile) ? fs.statSync(portFile).mtimeMs : null;
    receipt.phase = 'graceful-close';
    const close = cp.spawnSync(process.execPath, [path.join(root, 'close-current.cjs')], { encoding: 'utf8', windowsHide: true });
    receipt.close = { status: close.status, signal: close.signal, stdout: close.stdout ?? '',
      stderr: close.stderr ?? '', ...(close.error ? { error: close.error.message } : {}) };
    assert.equal(close.status, 0, 'Graceful owned close failed');
    let alive = true; try { process.kill(oldPid, 0); } catch { alive = false; }
    assert(!alive, 'Old desktop is still alive');
    const remaining = ownedProcessInventory(oldPid);
    assert.equal(remaining.length, 0, 'Owned Electron/ACP processes remain; runtime files will not be replaced.');
    for (const item of receipt.beforeProcesses) {
      let running = true; try { process.kill(item.pid, 0); } catch { running = false; }
      assert(!running, 'A previously owned native process remains; runtime files will not be replaced.');
    }
    receipt.ownedProcessesConfirmedClosed = true;
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
      const modules = runtimeModules;
      const replaced = [];
      try {
        for (const item of modules) {
          assert.equal(hash(fs.readFileSync(item.staged)), hash(item.bytes));
        }
        for (const item of changedRuntimeModules) {
          fs.renameSync(item.staged, item.target);
          replaced.push(item);
          if (item.kind === 'cli') receipt.cliModuleCopies++; else receipt.sdkCopies++;
        }
      } catch (error) {
        const copied = replaced.length;
        for (const item of replaced.reverse()) {
          const restore = `${item.target}.removal-restore-${stamp}`;
          fs.writeFileSync(restore, item.before, { flag: 'wx' });
          fs.renameSync(restore, item.target);
        }
        for (const item of modules) if (fs.existsSync(item.staged)) fs.unlinkSync(item.staged);
        receipt.cliModuleRollback = copied > 0;
        receipt.cliModuleCopies = 0; receipt.sdkCopies = 0;
        throw error;
      }
      receipt.checks.push(`applied ${receipt.cliModuleCopies} changed CLI and ${receipt.sdkCopies} changed SDK module(s) after graceful close; reviewed ${cliModules.length} CLI and ${sdkModules.length} SDK module(s)`);
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
    receipt.terminalAlertsAfter = after.dom.terminalAlerts;
    receipt.activePresentation = { before: hash(before.dom.presentations.find(([key]) => key === `namzu.workspace.presentation:${before.dom.activeTabId}`) ?? null),
      after: hash(after.dom.presentations.find(([key]) => key === `namzu.workspace.presentation:${after.dom.activeTabId}`) ?? null),
      rule: 'Graceful close may flush the active view; other presentation entries and visible page/scroll/preferences are protected.' };
    fs.writeFileSync(path.join(root, `removal-after-private-${stamp}.json`), JSON.stringify(after), { mode: 0o600 });
    for (const key of Object.keys(receipt.before)) assert.equal(receipt.after[key], receipt.before[key], `Protected ${key} changed across activation`);
    assert.equal(hash(fs.readFileSync(configPath)), hash(configBytes));
    assert.equal(hash(fs.readFileSync(path.join(config.app, 'package.json'))), hash(packageBytes));
    assert.deepEqual(manifest(target), sourceFiles);
    if (cliSource) {
      const expectedCli = cliBefore.map(item => {
        const replacement = cliModules.find(module => module.file === item.file);
        return replacement ? { ...item, hash: hash(replacement.bytes) } : item;
      });
      assert.deepEqual(manifest(path.dirname(config.cli)), expectedCli, 'Unrelated CLI files changed');
      const expectedSdk = expectedPayload(sdkBefore, sdkModules);
      assert.deepEqual(manifest(sdkTarget), expectedSdk, 'Unrelated SDK files changed');
      protectGraph();
      assert.equal(hash(fs.readFileSync(sdkPackagePath)), hash(sdkPackageBytes));
      assert.equal(hash(fs.readFileSync(cliPackagePath)), hash(cliPackageBytes));
      assert.deepEqual(dependencyGraph(cliPackagePath), cliDependencyGraph, 'CLI dependency mapping changed');
      receipt.cliManifestAfterSha256 = hash(expectedCli);
      receipt.sdkManifestAfterSha256 = hash(expectedSdk);
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
    try { cleanupCliStaging(); } catch (error) {
      receipt.cliStagingCleanupError = { name: error.name, message: error.message };
      process.exitCode = 1;
      receipt.passed = false;
    }
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ passed: receipt.passed, beforePid: receipt.beforePid, afterPid: receipt.afterPid, checks: receipt.checks.length, error: receipt.error ? 'See private activation receipt' : undefined }));
  }
})();
