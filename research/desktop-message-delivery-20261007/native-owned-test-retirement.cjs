'use strict';
// Explicit retirement of our isolated read-only test after diagnostic shutdown
// blocked normal close. Windows terminating this controller may retire its own
// child Job Object. This is not a graceful-close or completed-child claim.
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
if (!process.argv.includes('--retire-owned-test') || process.env.NAMZU_OWNED_TEST_RETIREMENT !== '1') {
  console.log(JSON.stringify({ action: 'Retire only the exact controller and its isolated read-only test job.', primaryActions: 0, defaultEffects: 0 }));
  process.exit(0);
}
assert.equal(process.platform, 'win32');
assert.deepEqual(process.argv.slice(2), ['--retire-owned-test']);
const root = path.join(process.env.LOCALAPPDATA, 'Namzu', 'Development');
const config = JSON.parse(fs.readFileSync(path.join(root, 'launch.json'), 'utf8'));
const primary = Number(fs.readFileSync(path.join(root, 'desktop.pid'), 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const previousBytes = fs.readFileSync(path.join(root, 'message-fixture-cleanup-private-dc4b1211-8a36-4621-b016-f5475ea55198.json'));
assert.equal(hash(previousBytes), '75ed1d8e4a92162134818165502cb0342e64a005609db2d0cbeb7a017a6ae376');
const previous = JSON.parse(previousBytes);
assert(previous.preflightPassed && previous.parentSessionsIdle && previous.explicitOwnedTestRetirement && previous.normalWindowCloseRequests === 1 && previous.primaryActions === 0);
const profile = 'message-delivery-userdata-07639574-d16e-4b4b-81af-4309ab7ec1b0';
function lineage() {
  const result = cp.spawnSync('powershell.exe', ['-NoProfile', '-Command',
    '$ErrorActionPreference="Stop";ConvertTo-Json -InputObject @(@(22440,35932,36540)|ForEach-Object {Get-CimInstance Win32_Process -Filter ("ProcessId = "+$_)}|ForEach-Object {[pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString("o");exe=$_.ExecutablePath;command=$_.CommandLine}}) -Compress'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0);
  const rows = JSON.parse(result.stdout);
  const controller = rows.find(row => row.pid === 22440);
  const launcher = rows.find(row => row.pid === 35932);
  const fixture = rows.find(row => row.pid === 36540);
  assert(controller && launcher && fixture);
  assert.equal(controller.created, '2026-10-07T06:17:34.7597380Z');
  assert.equal(launcher.created, '2026-10-07T06:17:37.6323110Z');
  assert.equal(fixture.created, '2026-10-07T06:17:37.6467550Z');
  assert.equal(launcher.parent, controller.pid);
  assert.equal(fixture.parent, launcher.pid);
  assert.equal(controller.exe.toLowerCase(), process.execPath.toLowerCase());
  assert.equal(launcher.exe.toLowerCase(), 'c:\\windows\\system32\\cmd.exe');
  assert.equal(fixture.exe.toLowerCase(), config.electron.toLowerCase());
  assert(controller.command.includes('desktop-message-delivery-20261007\\native-background-second-message-comparison.cjs') && controller.command.includes('--execute'));
  assert([launcher, fixture].every(row => row.command.includes(profile)));
  assert(rows.every(row => row.pid !== primary));
  process.kill(primary, 0);
}
(async () => {
  lineage();
  const { chromium } = require(path.join(root, 'runtime/packages/p39'));
  const browser = await chromium.connectOverCDP('http://127.0.0.1:59660');
  try {
    const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === new URL(config.url).href);
    assert(page);
    assert(await page.evaluate(() => document.querySelector('textarea[aria-label="Message Namzu"]')?.value === ''));
  } finally { browser._connection.close(); }
  lineage();
  // External Windows process termination bypasses the original Playwright JS
  // exit/SIGINT hooks. Its own child Job Object may still be terminated by OS.
  process.kill(22440, 'SIGTERM');
  process.kill(primary, 0);
  console.log(JSON.stringify({ schema: 'namzu.owned-read-only-test-retirement.v3', at: new Date().toISOString(),
    intentionalOwnedTestRetirement: true, priorNormalCloseReceiptSha256: hash(previousBytes),
    exactTwoLevelFixtureLineageVerified: true, emptyFixtureComposerVerified: true,
    terminatedOwnedAutomationControllers: 1, windowsOwnedChildJobMayBeTerminated: true,
    gracefulFixtureClosureClaimed: false, childCompletionClaimed: false,
    primaryActions: 0, userQueueActions: 0, modelRequests: 0, primaryStillAlive: true }));
})().catch(error => { console.error(error.name); process.exitCode = 1; });
