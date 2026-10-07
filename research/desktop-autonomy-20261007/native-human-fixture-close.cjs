"use strict";
// Close only the exact previously admitted, now settled owned fixture.
// Zero model requests. Normal renderer flush; no process tree termination.
const assert = require("node:assert/strict"),
	fs = require("node:fs"),
	path = require("node:path"),
	crypto = require("node:crypto"),
	cp = require("node:child_process");
if (!process.argv.includes("--execute")) {
	console.log(
		JSON.stringify({
			schema: "namzu.native-human-read-fixture-close-plan.v1",
			modelRequests: 0,
			action:
				"Recheck all owned fixture threads idle, detach fixture Inspector and close exact owned window normally.",
		}),
	);
	process.exit(0);
}
assert.equal(process.platform, "win32");
const previousPath = path.resolve(process.argv[2]),
	root = path.join(process.env.LOCALAPPDATA, "Namzu", "Development");
assert.equal(path.dirname(previousPath).toLowerCase(), root.toLowerCase());
const suffix = path
	.basename(previousPath)
	.match(/^harness-fixture-private-([0-9a-f-]{36})\.json$/)?.[1];
assert(suffix);
const previousBytes = fs.readFileSync(previousPath),
	previous = JSON.parse(previousBytes);
assert(
	previous.schema === "namzu.native-human-read-real.v1" &&
		previous.isolationVerified &&
		previous.realPromptsSent === 2 &&
		previous.failurePhase === "human-read-codex-cli" &&
		previous.ownedFixtureStillRunning,
);
assert(
	previous.engines.length === 2 &&
		previous.engines[0].outcome === "all-attempted-live-answers-observed",
);
const userData = path.join(root, "harness-fixture-userdata-" + suffix),
	config = JSON.parse(fs.readFileSync(path.join(root, "launch.json")));
const receipt = {
	schema: "namzu.native-human-read-fixture-close.v1",
	passed: false,
	priorReceiptSha256: crypto
		.createHash("sha256")
		.update(previousBytes)
		.digest("hex"),
	modelRequests: 0,
	pageErrorCount: 0,
};
const output = path.join(
	root,
	"human-read-close-private-" + crypto.randomUUID() + ".json",
);
function identity() {
	const p = cp.spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-Command",
			`$ErrorActionPreference='Stop';$r=Get-CimInstance Win32_Process -Filter "ProcessId = ${previous.fixturePid}"; if(!$r){throw 'Owned fixture absent'}; [pscustomobject]@{pid=[int]$r.ProcessId;parent=[int]$r.ParentProcessId;executable=$r.ExecutablePath;createdAt=$r.CreationDate.ToUniversalTime().ToString('o');command=$r.CommandLine}|ConvertTo-Json -Compress`,
		],
		{ encoding: "utf8", windowsHide: true },
	);
	assert.equal(p.status, 0);
	const r = JSON.parse(p.stdout);
	assert(
		r.pid === previous.fixturePid &&
			r.createdAt === previous.fixtureCreatedAt &&
			path.normalize(r.executable).toLowerCase() ===
				path.normalize(config.electron).toLowerCase() &&
			r.command.toLowerCase().includes(userData.toLowerCase()) &&
			r.command
				.toLowerCase()
				.includes(path.join(userData, "bootstrap.cjs").toLowerCase()),
	);
	assert.notEqual(r.pid, previous.originalPid);
	process.kill(previous.originalPid, 0);
	return r;
}
const initialIdentity = identity();
let browser,
	page,
	nodeSocket,
	nodeId = 0;
const requests = new Map();
let active = false;
async function nodeCall(method, params = {}) {
	const id = ++nodeId;
	const result = new Promise((resolve, reject) =>
		requests.set(id, { resolve, reject }),
	);
	nodeSocket.send(JSON.stringify({ id, method, params }));
	return result;
}
async function nodeEval(expression) {
	const r = await nodeCall("Runtime.evaluate", {
		expression,
		returnByValue: true,
		awaitPromise: true,
		includeCommandLineAPI: true,
	});
	assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
	return r.result.value;
}
async function main() {
	const ports = cp.spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-Command",
			`$ErrorActionPreference='Stop';ConvertTo-Json -InputObject @(Get-NetTCPConnection -State Listen -OwningProcess ${previous.fixturePid} | Select-Object -ExpandProperty LocalPort) -Compress`,
		],
		{ encoding: "utf8", windowsHide: true },
	);
	assert.equal(ports.status, 0);
	let target;
	for (const port of JSON.parse(ports.stdout)) {
		const r = await fetch("http://127.0.0.1:" + port + "/json/list").catch(
			() => null,
		);
		if (!r?.ok) continue;
		const rows = await r.json();
		const t = rows.find((t) => t.type === "node");
		if (t) {
			assert(!target);
			target = t;
		}
	}
	assert(target?.webSocketDebuggerUrl?.startsWith("ws://127.0.0.1:"));
	nodeSocket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		nodeSocket.addEventListener("open", resolve, { once: true });
		nodeSocket.addEventListener("error", reject, { once: true });
	});
	nodeSocket.addEventListener("message", (e) => {
		const m = JSON.parse(e.data),
			r = requests.get(m.id);
		if (r) {
			requests.delete(m.id);
			m.error ? r.reject(Error(m.error.message)) : r.resolve(m.result);
		}
	});
	const mainIdentity = JSON.parse(
		await nodeEval(
			"JSON.stringify({pid:process.pid,userData:require('electron').app.getPath('userData')})",
		),
	);
	assert(
		mainIdentity.pid === previous.fixturePid &&
			mainIdentity.userData === userData,
	);
	const { chromium } = require(path.join(root, "runtime/packages/p39"));
	const port = Number(
		fs
			.readFileSync(path.join(userData, "DevToolsActivePort"), "utf8")
			.split(/\r?\n/)[0],
	);
	browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
	page = browser
		.contexts()
		.flatMap((c) => c.pages())
		.find((p) => p.url() === new URL(config.url).href);
	assert(page);
	page.on("pageerror", () => receipt.pageErrorCount++);
	const idle = await page.evaluate(async () => {
		const api = window.namzu;
		if ((await api.pals()).length !== 0) return false;
		const ps = await api.projects();
		if (ps.length !== 1 || !ps[0].isChat || !ps[0].trusted) return false;
		for (const row of await api.conversations(ps[0].id)) {
			const t = (await api.openConversation(ps[0].id, row.id)).thread,
				j = await api.jobs(row.id);
			if (
				!t ||
				t.running ||
				t.responding ||
				t.retry ||
				t.retryNotice ||
				t.permissions.length ||
				t.queued.length ||
				t.queuedItems.length ||
				t.activeToolIds.length ||
				j.some((j) => j.status === "running" || j.recoveryRequired)
			)
				return false;
		}
		return true;
	});
	assert(idle);
	identity();
	await browser.close();
	browser = null;
	// Detach the inherited driver's Inspector without killing the app or process tree.
	// node:inspector.close() terminates debugger connections, then the normal window
	// close below executes Namzu's renderer flush. Exact PID/create/profile rechecked.
	await nodeEval(
		"(()=>{const taskInspector=require('node:inspector');setImmediate(()=>taskInspector.close());return true})()",
	);
	await new Promise((resolve) =>
		nodeSocket.readyState === WebSocket.CLOSED
			? resolve()
			: nodeSocket.addEventListener("close", resolve, { once: true }),
	);
	nodeSocket = null;
	identity();
	const close = cp.spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-Command",
			`$ErrorActionPreference='Stop';$r=Get-CimInstance Win32_Process -Filter "ProcessId = ${previous.fixturePid}"; if(!$r -or $r.CreationDate.ToUniversalTime().ToString('o') -ne '${previous.fixtureCreatedAt}' -or [int]$r.ParentProcessId -ne ${initialIdentity.parent}){throw 'Fixture identity changed'}; $p=Get-Process -Id ${previous.fixturePid};if(!$p.CloseMainWindow()){throw 'Normal close refused'};if(!$p.WaitForExit(30000)){throw 'Preserve unresolved fixture driver'};Write-Output '{"closed":true}'`,
		],
		{ encoding: "utf8", windowsHide: true },
	);
	assert.equal(close.status, 0);
	receipt.ownedFixtureClosed = true;
	receipt.cleanupMethod =
		"verified fixture Inspector detached; exact owned window normal close";
	process.kill(previous.originalPid, 0);
	receipt.originalProcessStillAlive = true;
	receipt.passed = true;
	receipt.modelRequests = 0;
}
(async () => {
	try {
		await main();
	} catch (error) {
		receipt.failureName = error.name;
		receipt.failureDiagnostic = String(error.message);
		receipt.ownedFixtureStillRunning = active;
	} finally {
		if (browser) await browser.close();
		if (nodeSocket) nodeSocket.close();
		fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n", {
			flag: "wx",
		});
		console.log(
			JSON.stringify({
				passed: receipt.passed,
				modelRequests: receipt.modelRequests,
				ownedFixtureClosed: receipt.ownedFixtureClosed,
				ownedFixtureStillRunning: receipt.ownedFixtureStillRunning,
				originalProcessStillAlive: receipt.originalProcessStillAlive,
			}),
		);
		if (!receipt.passed) process.exitCode = 1;
	}
})();
