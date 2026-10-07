'use strict';
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (!process.argv.includes('--close-finished-controllers') || process.env.NAMZU_FINISHED_CONTROLLERS !== '1') {
  console.log(JSON.stringify({ action: 'Retire exact finished diagnostic controllers; never target Electron, CLI or the primary.', defaultEffects: 0 }));
  process.exit(0);
}
assert.equal(process.platform, 'win32');
assert.deepEqual(process.argv.slice(2), ['--close-finished-controllers']);
const manifest = [
  { pid: 26628, created: '2026-10-07T06:26:14.2037760Z', helper: 'native-background-second-message-resume.cjs', receipt: 'message-delivery-resume-private-e86eb8e5-dec3-412c-ab68-8e5315c87eb6.json' },
  { pid: 34408, created: '2026-10-07T06:37:26.1831490Z', helper: 'native-owned-message-fixture-cleanup.cjs', receipt: 'message-fixture-cleanup-private-9afbdb74-9fdf-4d19-80cf-b59e14273b02.json' },
  { pid: 26452, created: '2026-10-07T06:38:11.0049380Z', helper: 'native-owned-message-fixture-cleanup.cjs', receipt: 'message-fixture-cleanup-private-dc4b1211-8a36-4621-b016-f5475ea55198.json' },
  { pid: 29240, created: '2026-10-07T06:46:12.3332500Z', helper: 'native-owned-test-retirement.cjs', publicReceipt: 'owned-read-only-test-retirement-v3.json' },
];
const root = path.join(process.env.LOCALAPPDATA, 'Namzu', 'Development');
const primary = Number(fs.readFileSync(path.join(root, 'desktop.pid'), 'utf8'));
assert(Number.isSafeInteger(primary) && primary > 0);
const result = { schema: 'namzu.finished-diagnostic-controller-retirement.v1', at: new Date().toISOString(), terminatedOwnFinishedControllers: 0, alreadyAbsent: 0, primaryActions: 0, appTerminationRequests: 0, modelRequests: 0 };
for (const expected of manifest) {
  const receiptFile = expected.publicReceipt ? path.join(__dirname, 'artifacts', expected.publicReceipt) : path.join(root, expected.receipt);
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  assert(receipt.completedObservation || receipt.preflightPassed || receipt.terminatedOwnedAutomationControllers === 1);
  assert.equal(receipt.primaryActions, 0);
  assert.notEqual(expected.pid, primary);
  const probe = cp.spawnSync('powershell.exe', ['-NoProfile', '-Command', `$r=Get-CimInstance Win32_Process -Filter "ProcessId = ${expected.pid}";if($r){[pscustomobject]@{created=$r.CreationDate.ToUniversalTime().ToString('o');exe=$r.ExecutablePath;command=$r.CommandLine}|ConvertTo-Json -Compress}else{Write-Output 'null'}`], { encoding: 'utf8', windowsHide: true });
  assert.equal(probe.status, 0);
  const row = JSON.parse(probe.stdout);
  if (!row) { result.alreadyAbsent++; continue; }
  assert.equal(row.created, expected.created);
  assert.equal(row.exe.toLowerCase(), process.execPath.toLowerCase());
  assert(row.command.includes(`desktop-message-delivery-20261007\\${expected.helper}`));
  process.kill(primary, 0);
  process.kill(expected.pid, 'SIGTERM');
  result.terminatedOwnFinishedControllers++;
}
process.kill(primary, 0);
console.log(JSON.stringify({ ...result, primaryStillAlive: true }));
