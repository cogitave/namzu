'use strict';

// Filesystem-only diagnostic for the single root-reviewed owned fixture.
// No native connection, model, process, UI action, repair or file write.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const fixture = '07639574-d16e-4b4b-81af-4309ab7ec1b0';
const plan = {
  schema: 'namzu.owned-background-metadata-plan.v1',
  fixtureReceiptBasename: `message-delivery-private-${fixture}.json`,
  operation: 'Strict SDK parent journal + only its successful Haiku background Agent receipt-derived child output file.',
  output: 'Hashes, counts, requested/observed model classification, allowed sleep call/result and terminal status; no thoughts, text, prompts, IDs or paths.',
  limits: { receiptBytes: 8 * 1024 * 1024, journalBytes: 16 * 1024 * 1024, childBytes: 16 * 1024 * 1024, lineBytes: 1024 * 1024, rows: 20000 },
  effects: { fileWrites: 0, nativeConnections: 0, modelRequests: 0, processActions: 0 },
  execute: 'node <script> --inspect-receipt=<exact private fixture receipt>',
};
const option = process.argv.slice(2);
if (!option.some(item => item.startsWith('--inspect-receipt='))) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(0);
}
assert.equal(option.length, 1, 'Exactly one pinned receipt option is accepted.');
const receiptFile = path.resolve(option[0].slice('--inspect-receipt='.length));
assert.equal(path.basename(receiptFile), plan.fixtureReceiptBasename);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const map = value => {
  assert(typeof value === 'string' && value.length > 0);
  if (process.platform === 'win32') return path.resolve(value);
  const match = value.match(/^([A-Za-z]):[\\/](.*)$/);
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}` : path.resolve(value);
};
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
function confinedRegular(file, root) {
  assert(inside(root, file), 'Diagnostic file escaped its exact owned root.');
  const rootInfo = fs.lstatSync(root);
  assert(rootInfo.isDirectory() && !rootInfo.isSymbolicLink());
  let cursor = root;
  const pieces = path.relative(root, file).split(path.sep);
  for (const [index, piece] of pieces.entries()) {
    assert(piece && piece !== '..');
    cursor = path.join(cursor, piece);
    const info = fs.lstatSync(cursor);
    assert(!info.isSymbolicLink(), 'Diagnostic refuses symlinks.');
    assert(index === pieces.length - 1 ? info.isFile() : info.isDirectory());
  }
  return fs.lstatSync(file);
}
function readBounded(file, root, maxBytes) {
  const info = confinedRegular(file, root);
  assert(info.size <= maxBytes, 'Diagnostic file exceeded its byte cap.');
  const fd = fs.openSync(file, 'r');
  const chunks = []; let bytes = 0;
  try {
    const opened = fs.fstatSync(fd);
    assert(opened.isFile() && opened.dev === info.dev && opened.ino === info.ino && opened.size <= maxBytes);
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - bytes + 1));
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      bytes += count;
      assert(bytes <= maxBytes, 'Diagnostic file grew beyond its byte cap.');
      chunks.push(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(fd);
    assert(after.dev === opened.dev && after.ino === opened.ino);
  } finally { fs.closeSync(fd); }
  return Buffer.concat(chunks);
}
function outputPath(result) {
  let object;
  try { object = JSON.parse(result); } catch { /* Native Agent uses a text receipt too. */ }
  if (object && typeof object === 'object' && !Array.isArray(object)) {
    for (const key of ['output_file', 'outputFile']) if (typeof object[key] === 'string') return object[key];
  }
  const candidate = result.match(/(?:^|\n)\s*output_file\s*:\s*([^\r\n]+)/i)?.[1];
  return candidate?.trim().replace(/^['"]|['"]$/g, '');
}
let phase = 'receipt';
(async () => {
  const development = path.dirname(receiptFile);
  assert.equal(path.basename(development).toLowerCase(), 'development');
  const receiptBytes = readBounded(receiptFile, development, plan.limits.receiptBytes);
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  assert.equal(receipt.schema, 'namzu.native-second-message-comparison.v1');
  assert.equal(receipt.fixturePid, 36540);
  assert.equal(receipt.fixtureCreatedAt, '2026-10-07T06:17:37.6467550Z');
  assert(receipt.isolationVerified && receipt.realUserUiSubmissions === 1);
  const prior = receipt.engines.find(row => row.engine === 'claude-code');
  assert(prior?.nativeEvidence?.available && /(^|[-_.])haiku($|[-_.])/i.test(prior.model));
  const home = path.join(development, `message-delivery-home-${fixture}`);
  const journalFile = map(prior.nativeEvidence.file);
  phase = 'strict-parent-journal';
  const parentBytes = readBounded(journalFile, home, plan.limits.journalBytes);
  const sdkFile = process.platform === 'win32'
    ? path.resolve(path.dirname(JSON.parse(readBounded(path.join(development, 'launch.json'), development, 1024 * 1024).toString('utf8')).cli), '../node_modules/@namzu/sdk/dist/public-runtime.js')
    : path.resolve(__dirname, '../../packages/sdk/dist/public-runtime.js');
  const sdk = await import(pathToFileURL(sdkFile).href);
  const log = await sdk.readSessionLog(journalFile, { sessionId: prior.nativeEvidence.runtimeId });
  const records = log.entries.map(entry => entry.record);
  const start = records.find(row => row.type === 'session_started');
  // Native HarnessBinding uses "claude"; Desktop's route is "claude-code".
  assert(start?.cwd && start.harness?.engineId === 'claude');
  const cwd = start.cwd;
  assert(map(cwd).toLowerCase().includes(fixture.toLowerCase()), 'Parent cwd lacks exact fixture identity.');
  const calls = new Map();
  for (const row of records) {
    const key = `${row.turnId}:${row.toolUseId}`;
    if (row.type === 'tool_executing') calls.set(key, { start: row });
    else if (row.type === 'tool_completed' && calls.has(key)) calls.get(key).completed = row;
  }
  const launches = [...calls.values()].filter(row =>
    /(?:^|:)Agent$|(?:^|:)Task$/i.test(row.start.toolName) &&
    row.start.input?.model === 'haiku' && row.start.input?.run_in_background === true &&
    row.completed?.isError === false);
  assert.equal(launches.length, 1, 'Exactly one successful requested Haiku background launch is required.');
  assert.equal(typeof launches[0].completed.result, 'string');
  const derivedPath = outputPath(launches[0].completed.result);
  assert(derivedPath, 'Successful native launch did not record an output_file.');
  const childFile = map(derivedPath);
  const temp = path.join(path.dirname(path.dirname(development)), 'Temp');
  const encodedCwd = cwd.replace(/[^A-Za-z0-9]/g, '-');
  const parentNativeId = start.harness.nativeSessionId;
  assert(typeof parentNativeId === 'string' && /^[0-9a-f-]{36}$/i.test(parentNativeId));
  const childRoot = path.join(temp, 'claude', encodedCwd, parentNativeId, 'tasks');
  assert.equal(path.dirname(childFile).toLowerCase(), childRoot.toLowerCase(), 'Child output path does not match exact fixture cwd.');
  assert(/^[A-Za-z0-9_-]+\.output$/.test(path.basename(childFile)), 'Native child output basename malformed.');
  const childTaskId = path.basename(childFile, '.output');
  phase = 'bounded-child-metadata';
  const childBytes = readBounded(childFile, path.join(temp, 'claude'), plan.limits.childBytes);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(childBytes);
  const lines = text.split(/\r?\n/);
  assert(lines.length <= plan.limits.rows);
  const metadata = { rows: 0, assistantFrames: 0, userFrames: 0, systemFrames: 0,
    toolStarts: 0, toolResults: 0, toolErrors: 0, allowedSleepCalls: 0,
    allowedSleepToolSuccessReceipts: 0, allowedForegroundSleepToolSuccessReceipts: 0,
    allowedBackgroundSleepLaunchReceipts: 0, unspecifiedSleepModeToolSuccessReceipts: 0,
    otherToolCalls: 0, permissionRequestFrames: 0, permissionErrorFrames: 0,
    successfulResultFrames: 0, failedResultFrames: 0, nativeTaskCompletedFrames: 0,
    nativeTaskFailedFrames: 0, haikuModelFrames: 0, otherModelFrames: 0,
    incompleteTrailingRow: false };
  const sleepIds = new Map();
  const sleepCommands = new Set(['sleep 30', 'powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 30"']);
  const nativePowerShellCommands = new Set(['Start-Sleep -Seconds 30']);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    assert(Buffer.byteLength(line) <= plan.limits.lineBytes);
    let row;
    try { row = JSON.parse(line); } catch (error) {
      if (index === lines.length - 1 && !text.endsWith('\n')) { metadata.incompleteTrailingRow = true; break; }
      throw error;
    }
    assert(row && typeof row === 'object' && !Array.isArray(row));
    metadata.rows++;
    if (row.type === 'assistant') metadata.assistantFrames++;
    if (row.type === 'user') metadata.userFrames++;
    if (row.type === 'system') metadata.systemFrames++;
    const model = row.message?.model ?? row.model;
    if (typeof model === 'string') /(^|[-_.])haiku($|[-_.])/i.test(model) ? metadata.haikuModelFrames++ : metadata.otherModelFrames++;
    if (row.type === 'control_request' && row.request?.subtype === 'can_use_tool') metadata.permissionRequestFrames++;
    if (row.type === 'control_response' && row.response?.subtype === 'error') metadata.permissionErrorFrames++;
    if (row.type === 'result') row.is_error === false && row.subtype === 'success' ? metadata.successfulResultFrames++ : metadata.failedResultFrames++;
    if (row.type === 'system' && row.subtype === 'task_notification' && row.task_id === childTaskId) {
      if (row.status === 'completed') metadata.nativeTaskCompletedFrames++;
      if (row.status === 'failed' || row.status === 'stopped') metadata.nativeTaskFailedFrames++;
    }
    const content = row.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      // Thinking, text and tool-result body strings are deliberately not inspected.
      if (block.type === 'tool_use') {
        metadata.toolStarts++;
        if (((block.name === 'Bash' && sleepCommands.has(block.input?.command)) ||
          (block.name === 'PowerShell' && nativePowerShellCommands.has(block.input?.command))) && typeof block.id === 'string') {
          metadata.allowedSleepCalls++; sleepIds.set(block.id, block.input?.run_in_background);
        } else metadata.otherToolCalls++;
      } else if (block.type === 'tool_result') {
        metadata.toolResults++;
        if (block.is_error === true) metadata.toolErrors++;
        if (sleepIds.has(block.tool_use_id) && block.is_error !== true) {
          metadata.allowedSleepToolSuccessReceipts++;
          const background = sleepIds.get(block.tool_use_id);
          if (background === true) metadata.allowedBackgroundSleepLaunchReceipts++;
          else if (background === false) metadata.allowedForegroundSleepToolSuccessReceipts++;
          else metadata.unspecifiedSleepModeToolSuccessReceipts++;
        }
      }
    }
  }
  process.stdout.write(`${JSON.stringify({ schema: 'namzu.owned-background-metadata.v1',
    at: new Date().toISOString(), fixtureReceiptSha256: sha(receiptBytes),
    strictParentJournal: true, parentJournalPostObservationSha256: sha(parentBytes), parentRecordCount: records.length,
    oneRequestedHaikuBackgroundLaunch: true, exactChildPathDerivedFromLaunch: true,
    childPostObservationSha256: sha(childBytes), childBytes: childBytes.length, metadata,
    terminalStatusObserved: metadata.successfulResultFrames > 0 || metadata.failedResultFrames > 0 || metadata.nativeTaskCompletedFrames > 0 || metadata.nativeTaskFailedFrames > 0,
    limitations: ['Post-observation hashes only, not a pre/post byte-preservation claim.', 'Missing terminal frames mean unknown lifetime; no inferred completion.', 'Background shell success is a launch receipt, never evidence the sleep or child completed.', 'Foreground/unspecified fields classify the recorded request mode and tool success only; no elapsed-duration inference.', 'Child thought/text/prompt/result bodies are not copied or analyzed.'],
    effects: plan.effects })}\n`);
})().catch(error => {
  process.stdout.write(`${JSON.stringify({ schema: 'namzu.owned-background-metadata.v1', completed: false, failurePhase: phase, failureName: error.name, effects: plan.effects })}\n`);
  process.exitCode = 1;
});
