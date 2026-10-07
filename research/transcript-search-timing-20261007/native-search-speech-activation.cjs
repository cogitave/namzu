"use strict";
// Reuse the immutable native activation guard. Review nine runtime modules;
// update only CLI history and SDK provider-hosted activity mapping.
// Invocation and all ownership/state/graph checks are inherited verbatim.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const original = path.resolve(
	__dirname,
	"../runtime-desktop-20260930/transcript-content-desktop-activation-native-20261007.cjs",
);
const bytes = fs.readFileSync(original);
assert.equal(
	crypto.createHash("sha256").update(bytes).digest("hex"),
	"f85cd8f55dd95cd76ffdbfc166d15410d383470f7c6fd3296cfb8dee4693e56d",
	"The inherited guard changed; review it before applying this adapter.",
);
const desktopOnlyFlags = process.argv.filter(arg => arg === '--desktop-only');
assert(desktopOnlyFlags.length <= 1, 'Repeated Desktop-only mode');
const desktopOnly = desktopOnlyFlags.length === 1;
process.argv = process.argv.filter(arg => arg !== '--desktop-only');
const changedRuntimeSet = desktopOnly ? [] : ['cli/commands/desktop-host.js', 'sdk/bridge/acp/update.js'];
let code = bytes.toString("utf8");
function replaceOnce(before, after) {
	assert.equal(
		code.split(before).length,
		2,
		"The reviewed guard seam changed.",
	);
	code = code.replace(before, after);
}
replaceOnce(
	"const config = JSON.parse(configBytes);",
	"const config = JSON.parse(configBytes);\n" +
		"const launcherBytes = fs.readFileSync(path.join(root, 'launch.cjs'));\n" +
		"assert.equal(crypto.createHash('sha256').update(launcherBytes).digest('hex'), 'ca9aafb2a9f00a335bc2c53fe24dcd07ec8c2cda9033e55a743280cfb0e16509', 'The reviewed launcher and selected Podman machine changed.');",
);
replaceOnce(
  "const validFlags = new Set([...sourceOptions.map(item => item.option), '--verify-from=', ...modes]);",
  "sourceOptions.push({ option: '--sdk-web-activity-source=', kind: 'sdk', file: 'bridge/acp/update.js', label: 'HostedWebActivity', additions: new Map(), addedExports: [] });\n" +
  "const validFlags = new Set([...sourceOptions.map(item => item.option), '--verify-from=', ...modes]);",
);
replaceOnce(
	"const expectedChangedRuntimeSet = [\n  'cli/commands/desktop-host.js',\n  'cli/integrations/harness/claude-protocol.js',\n  'cli/integrations/sessions/store.js',\n];",
	`const expectedChangedRuntimeSet = ${JSON.stringify(changedRuntimeSet)};`,
);
replaceOnce(
	"    assert.deepEqual(nextNames.filter(name => !additions.includes(name)), previousNames.filter(name => !additions.includes(name)),\n      `Import changed beyond reviewed additions in ${item.file}.`);",
	"    const removedHistoryReader = name => item.file === 'commands/desktop-host.js' && specifier === '../integrations/sessions/store.js' && name === 'loadConversation';\n" +
		"    if (previousNames.some(removedHistoryReader)) assert(!nextNames.includes('loadConversation'), 'The replaced history reader remains imported.');\n" +
		"    assert.deepEqual(nextNames.filter(name => !additions.includes(name)), previousNames.filter(name => !additions.includes(name) && !removedHistoryReader(name)),\n" +
		"      `Import changed beyond reviewed additions and the removed history reader in ${item.file}.`);",
);
replaceOnce(
	"'eight reviewed modules; only desktop-host, Claude protocol and session store may change'",
	`'nine reviewed modules; exact reviewed changes: ${changedRuntimeSet.join(", ") || "Desktop only"}; unrelated runtime payload byte exact'`,
);
replaceOnce(
	"\t\t\t\t\tcontrol: computer.control,\n",
	"\t\t\t\t\tcontrol: computer.control,\n\t\t\t\t\tnotice: computer.notice,\n\t\t\t\t\trequiresStop: computer.requiresStop,\n",
);
replaceOnce(
	"function digests(state) { return Object.fromEntries(Object.entries(semantic(state)).map(([name, value]) => [name, hash(value)])); }",
	"function digests(state) { return Object.fromEntries(Object.entries(semantic(state)).map(([name, value]) => [name, hash(value)])); }\n" +
		"function assertComputersQuiescent(state) {\n" +
		"  if (state.computers.every(computer => computer.status === 'stopped')) return;\n" +
		"  assert(state.computers.every(computer => computer.status === 'stopped' || (computer.status === 'unavailable' && computer.notice === 'The selected Podman machine is stopped or unavailable; start it explicitly' && !computer.requiresStop && !computer.environmentId && !computer.generation && !computer.control)), 'Unavailable computer has no proved quiescent lifetime.');\n" +
		"  assert(typeof config.podman === 'string' && fs.statSync(config.podman).isFile());\n" +
		"  assert.equal(hash(fs.readFileSync(path.join(root, 'launch.cjs'))), hash(launcherBytes), 'The selected-machine launcher changed.');\n" +
		"  const probe = cp.spawnSync(config.podman, ['machine', 'inspect', 'podman-machine-default'], { cwd: root, encoding: 'utf8', windowsHide: true });\n" +
		"  assert.equal(probe.status, 0, 'Podman machine state cannot be verified.');\n" +
		"  const machines = JSON.parse(probe.stdout);\n" +
		"  assert(Array.isArray(machines) && machines.length === 1 && machines[0].Name === 'podman-machine-default' && machines[0].State === 'stopped', 'The selected Podman machine must be physically stopped.');\n" +
		"  receipt.launcherSha256 = hash(launcherBytes);\n" +
		"  receipt.physicalStoppedMachineObservations = (receipt.physicalStoppedMachineObservations ?? 0) + 1;\n" +
		"}",
);
replaceOnce(
	"    assert(before.computers.every(computer => computer.status === 'stopped'), 'All Pal computers must be stopped before native restart.');",
	"    assertComputersQuiescent(before);",
);
replaceOnce(
	"    const oldPortStamp = fs.existsSync(portFile) ? fs.statSync(portFile).mtimeMs : null;",
	"    assertComputersQuiescent(finalState);\n    const oldPortStamp = fs.existsSync(portFile) ? fs.statSync(portFile).mtimeMs : null;",
);
replaceOnce(
	"      const after = await readState();\n      receipt.beforePid",
	"      const after = await readState();\n      assertComputersQuiescent(after);\n      receipt.beforePid",
);
replaceOnce(
	"    for (const key of Object.keys(receipt.before)) assert.equal(receipt.after[key], receipt.before[key], `Protected ${key} changed across activation`);",
	"    assertComputersQuiescent(after);\n    for (const key of Object.keys(receipt.before)) assert.equal(receipt.after[key], receipt.before[key], `Protected ${key} changed across activation`);",
);

// A restarted app must also be idle with respect to its global voice worker.
// Model/voice preferences stay byte exact; RAM/CPU observations are process-local.
replaceOnce(
  "\t\tif (!api) throw new Error('Native preload API is missing.');",
  "\t\tif (!api) throw new Error('Native preload API is missing.');\n" +
  "\t\tif (api.localSpeechState) { const speech = await api.localSpeechState(); if (speech.installation === 'installing' || ['loading', 'speaking'].includes(speech.worker)) throw new Error('Local speech has active installation or playback.'); }",
);
replaceOnce(
  "const target = path.join(config.app, 'dist');",
  "const voiceDirectory = path.join(process.env.APPDATA, 'Namzu', 'local-speech');\n" +
  "const voiceFiles = ['settings.json', 'installation.json'];\n" +
  "const voiceBefore = voiceFiles.map(name => { const file = path.join(voiceDirectory, name); if (!fs.existsSync(file)) return null; const stat = fs.lstatSync(file); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024); return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); });\n" +
  "function protectVoiceFiles() { for (let i = 0; i < voiceFiles.length; i++) { const file = path.join(voiceDirectory, voiceFiles[i]); if (voiceBefore[i] === null) { assert(!fs.existsSync(file), 'A new voice preference was written during activation.'); continue; } const stat = fs.lstatSync(file); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024); assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), voiceBefore[i], 'Voice preferences or installation identity changed.'); } }\n" +
  "const target = path.join(config.app, 'dist');",
);
replaceOnce(
  "    receipt.sourceBytesMatch = true;\n    receipt.computerStates",
  "    protectVoiceFiles();\n    receipt.voicePreferencesAndInstallationPreserved = true;\n    receipt.sourceBytesMatch = true;\n    receipt.computerStates",
);

// SDK journal clocks apply to Namzu sessions. The unchanged native CLI harness
// adapters preserve their exact cold message content and unknown clocks through
// the inherited semantic comparison; they do not use the SDK session journal.
replaceOnce(
  "\t\t\t\tprojectId: view.projectId,\n\t\t\t\tmessages: history.messages,",
  "\t\t\t\tprojectId: view.projectId,\n\t\t\t\tharness: view.harness ?? 'namzu',\n\t\t\t\tmessages: history.messages,",
);

// Message content comparison excludes only the new clock field. Its values are
// validated independently against exact, unchanged durable journal bytes below.
replaceOnce(
  "messages: item.messages.map(({messageId, status, stopReason, ...body}) => body)",
  "messages: item.messages.map(({messageId, status, stopReason, time, ...body}) => body)",
);
replaceOnce(
  "async function readState() {",
  `const journalRoot = path.join(process.env.USERPROFILE, '.namzu', 'projects');
let journalEntries = 0;
function captureJournals(state, previous, requireClocks = mode === '--verify-current') {
  assert(fs.lstatSync(journalRoot).isDirectory() && !fs.lstatSync(journalRoot).isSymbolicLink());
  const ids = new Set(state.sessions.filter(session => session.harness === 'namzu').map(session => session.id));
  const found = new Map();
  function visit(directory, depth) {
    assert(depth <= 2);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert(++journalEntries <= 50000, 'Journal scan exceeded its bounded inventory.');
      const file = path.join(directory, entry.name);
      const stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink(), 'Journal scan refuses redirected paths.');
      if (stat.isDirectory()) { if (depth < 2) visit(file, depth + 1); }
      else if (stat.isFile() && entry.name.endsWith('.jsonl')) {
        const id = entry.name.slice(0, -6);
        if (!ids.has(id)) continue;
        assert(!found.has(id), 'A conversation journal is ambiguous.');
        assert(stat.size <= 128 * 1024 * 1024, 'Journal exceeds bounded activation read.');
        const bytes = fs.readFileSync(file);
        assert(bytes.length <= 128 * 1024 * 1024, 'Journal exceeds bounded activation read.');
        const records = bytes.toString('utf8').split(/\\r?\\n/).filter(Boolean).map(line => JSON.parse(line));
        assert(records.some(record => record.type === 'session_started' && record.sessionId === id), 'Journal session identity differs.');
        found.set(id, { hash: hash(bytes), records });
      }
    }
  }
  journalEntries = 0;
  visit(journalRoot, 0);
  for (const session of state.sessions) {
    if (session.harness !== 'namzu') {
      assert(['codex-cli', 'claude-code'].includes(session.harness), 'Unknown native harness clock authority.');
      assert(session.messages.every(message => !message.time), 'Native harness has an unvalidated cold history clock.');
      continue;
    }
    const captured = found.get(session.id);
    if (!captured) {
      // An ordinary ACP session has no journal until its first authored turn.
      // The inherited comparison still protects its empty history and catalogue.
      assert.equal(session.messages.length, 0, 'A nonempty authored conversation journal is missing: ' + session.id);
      if (previous) assert(!Object.hasOwn(previous, session.id), 'An authored journal disappeared.');
      continue;
    }
    if (previous) assert.equal(captured.hash, previous[session.id], 'Durable authored journal changed across activation.');
    const starts = new Map();
    const messages = new Map();
    for (const record of captured.records) {
      if (record.type !== 'message_started' && record.type !== 'message') continue;
      const at = Date.parse(record.ts);
      if (!Number.isFinite(at) || at < 0) continue;
      if (record.type === 'message_started') {
        const old = starts.get(record.messageId);
        starts.set(record.messageId, { turnId: record.turnId, seq: old?.seq ?? record.seq,
          at: old?.at ?? at, ambiguous: Boolean(old && (old.ambiguous || old.turnId !== record.turnId)) });
      } else if (record.role === 'user' || record.role === 'assistant') {
        const old = messages.get(record.messageId);
        messages.set(record.messageId, { turnId: record.turnId, role: record.role,
          seq: old?.seq ?? record.seq, at: old?.at ?? at, ambiguous: Boolean(old) });
      }
    }
    for (const message of session.messages) {
      // A settled live cache legitimately has host observations, including an
      // admitted user prompt before its durable identity is restored. Preserve
      // authored journal bytes; after restart require only exact durable clocks.
      if (!requireClocks && message.time?.source === 'host') {
        assert(Number.isFinite(message.time.at) && message.time.at >= 0 && message.time.at <= 8640000000000000);
        continue;
      }
      const record = message.messageId && messages.get(message.messageId);
      if (!record || record.ambiguous || record.role !== message.role) {
        assert(!message.time, 'Unknown or ambiguous message identity acquired a clock.');
        continue;
      }
      const start = starts.get(message.messageId);
      const at = start && !start.ambiguous && start.turnId === record.turnId && start.seq <= record.seq ? start.at : record.at;
      // The old live cache can retain message IDs before timestamp support exists.
      // After the upgraded source is active, every eligible known ID must carry its clock.
      if (!message.time && !requireClocks) continue;
      assert.deepEqual(message.time, { at, source: 'journal' }, 'Known journal message clock differs or is missing.');
    }
  }
  return Object.fromEntries([...found].map(([id, row]) => [id, row.hash]));
}
async function readState() {`,
);
replaceOnce(
  "    before = await readState();\n    assert.equal(before.workspace.layout.windows.length, 1);",
  "    before = await readState();\n    receipt.durableJournals = captureJournals(before);\n    assert.equal(before.workspace.layout.windows.length, 1);",
);
replaceOnce(
  "    assert.deepEqual(digests(finalState), receipt.before, 'State changed during staging');",
  "    captureJournals(finalState, receipt.durableJournals);\n    assert.deepEqual(digests(finalState), receipt.before, 'State changed during staging');",
);
replaceOnce(
  "      assert.deepEqual(receipt.after, receipt.before, 'Protected durable/display state differs');",
  "      assert.deepEqual(captureJournals(after, previous.durableJournals, true), previous.durableJournals);\n      receipt.durableJournals = previous.durableJournals;\n      assert.deepEqual(receipt.after, receipt.before, 'Protected durable/display state differs');",
);
replaceOnce(
  "    for (const key of Object.keys(receipt.before)) assert.equal(receipt.after[key], receipt.before[key], `Protected ${key} changed across activation`);",
  "    assert.deepEqual(captureJournals(after, receipt.durableJournals, true), receipt.durableJournals);\n    receipt.journalClocksValidated = true;\n    for (const key of Object.keys(receipt.before)) assert.equal(receipt.after[key], receipt.before[key], `Protected ${key} changed across activation`);",
);
// Preserve every original receipt and the original helper. No graph, authority,
// message, profile, draft, presentation or action check is loosened. The only
// computer exception requires exact inert metadata plus the stopped physical VM,
// checked before staging/close and after restart. Unknown is never treated as zero.
const inherited = new Module(original, module);
inherited.filename = original;
inherited.paths = Module._nodeModulePaths(path.dirname(original));
inherited._compile(code, original);
