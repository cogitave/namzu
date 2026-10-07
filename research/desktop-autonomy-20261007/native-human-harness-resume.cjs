"use strict";
// Resume only a pinned failed owned read fixture; no re-send of admitted turns.
// Remaining budget: one offered Claude Haiku request. No primary profile writes.
const assert = require("node:assert/strict"),
	fs = require("node:fs"),
	path = require("node:path"),
	crypto = require("node:crypto"),
	cp = require("node:child_process");
if (!process.argv.includes("--execute")) {
	console.log(
		JSON.stringify({
			schema: "namzu.native-human-read-resume-plan.v1",
			additionalPromptsMax: 1,
			action:
				"Finish only the pending owned Codex read, then one offered Claude Haiku request.",
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
	schema: "namzu.native-human-read-resume.v1",
	passed: false,
	priorReceiptSha256: crypto
		.createHash("sha256")
		.update(previousBytes)
		.digest("hex"),
	maxRealPrompts: 3,
	realPromptsSent: 2,
	additionalPromptsSent: 0,
	engines: structuredClone(previous.engines),
	pageErrorCount: 0,
};
const output = path.join(
	root,
	"human-read-resume-private-" + crypto.randomUUID() + ".json",
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
let active = true;
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
	const sourcePath = path.resolve(
			__dirname,
			"../runtime-desktop-20260930/native-harness-isolated-real-20261006.cjs",
		),
		bytes = fs.readFileSync(sourcePath);
	assert.equal(
		crypto.createHash("sha256").update(bytes).digest("hex"),
		"ea0a2ebc3b18e69b2e396230a24976d3f78a3bf83041397cb1ef72bb7e70d6e7",
	);
	let helpers = bytes
		.toString()
		.slice(
			bytes.toString().indexOf("async function owner()"),
			bytes.toString().indexOf("async function sendOne("),
		);
	helpers = helpers.replace(
		"models.find((item) => /haiku/i.test(item.id)) ??\n\t\t\t\tmodels.find((item) => /sonnet/i.test(item.id)) ?? models[0]",
		"models.find((item) => /haiku/i.test(item.id))",
	);
	helpers = helpers.replace(
		"if (await popup.isVisible()) await page.keyboard.press('Escape');",
		"if (await popup.isVisible()) { await page.getByRole('button', {name:'Select model',exact:true}).click(); await popup.waitFor({state:'hidden'}); }",
	);
	helpers = helpers.replace(
		"await page.keyboard.press('Escape');\n\t\tawait popup.waitFor({ state: 'hidden' });",
		"await page.getByRole('button', {name:'Select model',exact:true}).click();\n\t\tawait popup.waitFor({ state: 'hidden' });",
	);
	const turn = require("./native-human-read-turn.cjs").toString();
	let resumed = turn.replace("function sendOne(", "function finishExisting(");
	const begin = resumed.indexOf("const before = await page.evaluate("),
		end = resumed.indexOf("let approvals = 0;", begin);
	assert(begin > 0 && end > begin);
	resumed =
		resumed.slice(0, begin) +
		"  const before = {count:0,turn:0};\n  activeTurn = true;\n" +
		resumed.slice(end);
	const runner = new Function(
		"bindings",
		`const {assert,fs,path,process,page,userData,receipt,desktop}=bindings;let phase='',activeTurn=true;const preference=['gpt-6.1-luna','gpt-6-luna','gpt-5.6-luna'];const effortOrder=['none','minimal','low','medium','high','xhigh','max','ultra'];const effortName={none:'None',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra high',max:'Max',ultra:'Ultra'};const modeName={namzu:{prompt:'Ask first',auto:'Allow tools',plan:'Plan'},'codex-cli':{prompt:'Ask first',auto:'Full access',plan:'Plan'},'claude-code':{prompt:'Ask first',plan:'Plan'}};${helpers}\n${resumed}\nconst sendOne=${turn};return {owner,finishExisting,newFixtureChat,selectEngine,catalogue,selectModel,verifyWarmCatalogue,setMode,setLowestOfferedEffort,sendOne,isActive:()=>activeTurn};`,
	);
	const api = runner({
		assert,
		fs,
		path,
		process,
		page,
		userData,
		receipt,
		desktop: { evaluate: (fn) => nodeEval("(" + fn.toString() + ")()") },
	});
	const view = await api.owner();
	assert(view.isolated);
	const pending = await page.evaluate(
		() => window.__namzuHarnessProbe?.state.permission,
	);
	assert(
		pending &&
			pending.sessionId === view.sessionId &&
			pending.projectId === view.projectId,
	);
	const codex = receipt.engines[1];
	assert(
		codex.engine === "codex-cli" &&
			/luna/i.test(codex.initialModel) &&
			codex.turns.length === 0,
	);
	codex.turns.push(
		await api.finishExisting(
			view,
			"codex-cli",
			"prompt",
			"codex-cli",
			codex.initialModel,
		),
	);
	active = api.isActive();
	codex.outcome = codex.turns.every(
		(t) =>
			t.stopReason === "end_turn" &&
			t.factsMatch &&
			t.routeMatches &&
			t.completedToolRows > 0 &&
			!t.liveStatusVisible,
	)
		? "all-attempted-live-answers-observed"
		: "inconclusive";
	await api.newFixtureChat();
	const claudeView = await api.selectEngine("claude-code");
	const data = await api.catalogue(
		claudeView.projectId,
		claudeView.sessionId,
		"claude-code",
	);
	assert(data.provider && data.choice && /haiku/i.test(data.choice.id));
	const claude = {
		engine: "claude-code",
		offered: true,
		catalogueRows: data.models.length,
		initialModel: data.choice.id,
		modes: [],
		turns: [],
	};
	receipt.engines.push(claude);
	await api.selectModel(claudeView, data.provider, data.choice);
	claude.warmCatalogue = await api.verifyWarmCatalogue();
	for (const mode of ["prompt", "plan"]) {
		await api.setMode(claudeView, "claude-code", mode);
		claude.modes.push(mode);
	}
	await api.setMode(claudeView, "claude-code", "prompt");
	claude.effort = await api.setLowestOfferedEffort(
		claudeView,
		data.provider,
		data.choice,
	);
	active = true;
	claude.turns.push(
		await api.sendOne(
			claudeView,
			"claude-code",
			"prompt",
			data.provider.id,
			data.choice.id,
		),
	);
	active = api.isActive();
	receipt.additionalPromptsSent = receipt.realPromptsSent - 2;
	claude.outcome = claude.turns.every(
		(t) =>
			t.stopReason === "end_turn" &&
			t.factsMatch &&
			t.routeMatches &&
			t.completedToolRows > 0 &&
			!t.liveStatusVisible,
	)
		? "all-attempted-live-answers-observed"
		: "inconclusive";
	assert(
		!active &&
			receipt.realPromptsSent === 3 &&
			receipt.pageErrorCount === 0 &&
			receipt.engines.every(
				(e) => e.outcome === "all-attempted-live-answers-observed",
			),
	);
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
}
(async () => {
	try {
		await main();
	} catch (error) {
		receipt.failureName = error.name;
		receipt.failureDiagnostic = String(error.message);
		receipt.ownedFixtureStillRunning = active;
		receipt.additionalPromptsSent = receipt.realPromptsSent - 2;
	} finally {
		if (browser) await browser.close();
		if (nodeSocket) nodeSocket.close();
		fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n", {
			flag: "wx",
		});
		console.log(
			JSON.stringify({
				passed: receipt.passed,
				totalRealPrompts: receipt.realPromptsSent,
				additionalPrompts: receipt.additionalPromptsSent,
				engines: receipt.engines.map((e) => ({
					engine: e.engine,
					model: e.initialModel,
					outcome: e.outcome,
					turns: e.turns.map((t) => ({
						stopReason: t.stopReason,
						factsMatch: t.factsMatch,
						toolRows: t.completedToolRows,
						visiblePhaseLabels: t.visiblePhaseLabels,
					})),
				})),
				ownedFixtureClosed: receipt.ownedFixtureClosed,
				ownedFixtureStillRunning: receipt.ownedFixtureStillRunning,
				originalProcessStillAlive: receipt.originalProcessStillAlive,
			}),
		);
		if (!receipt.passed) process.exitCode = 1;
	}
})();
