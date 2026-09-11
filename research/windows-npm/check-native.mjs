// Synthetic npm launcher checks; never runs real npm, installation, or a provider.
// Optional first argument: native Windows node.exe path when invoking from WSL.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const sourceRoot = new URL("../../packages/cli/src/", import.meta.url);
const files = [
	"integrations/npm-invocation.ts",
	"integrations/providers/setup.ts",
	"commands/upgrade.ts",
	"commands/upgrade-progress.ts",
	"integrations/updates.ts",
	"exit-codes.ts",
	"tui/logo.ts",
	"tui/theme.ts",
];
const modules = Object.fromEntries(
	files.map((name) => [
		name.replace(/\.ts$/u, ".js"),
		ts.transpileModule(readFileSync(new URL(name, sourceRoot), "utf8"), {
			compilerOptions: {
				module: ts.ModuleKind.ES2022,
				target: ts.ScriptTarget.ES2022,
			},
		}).outputText,
	]),
);

async function nativeCheck(modules) {
	const assert = (await import("node:assert/strict")).default;
	const { execFileSync, spawnSync } = await import("node:child_process");
	const { dirname, join } = await import("node:path");
	const { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } =
		await import("node:fs");
	const { tmpdir } = await import("node:os");
	assert.equal(process.platform, "win32");
	const root = mkdtempSync(join(tmpdir(), "namzu npm & %PATH% !-"));
	try {
		const runtime = join(root, "runtime");
		mkdirSync(runtime);
		const node = join(runtime, "node.exe");
		// A temporary copy gives the real Node executable an isolated npm
		// bundle beside it without modifying the installed executable.
		copyFileSync(process.execPath, node);
		const npmCli = join(runtime, "node_modules", "npm", "bin", "npm-cli.js");
		mkdirSync(dirname(npmCli), { recursive: true });
		writeFileSync(
			npmCli,
			`
const {spawn}=require('node:child_process');
if (process.argv.includes('--hold-tree')) {
	const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']});
	process.stdout.write(JSON.stringify({child:child.pid})+'\\n');
	setInterval(()=>{},1000);
} else if (process.argv.includes('--hold-one')) {
	process.stdout.write('ready\\n');
	setInterval(()=>{},1000);
} else {
	process.stdout.write(JSON.stringify(process.argv.slice(2)));
}
`,
		);
		const shim = join(runtime, "npm.cmd");
		writeFileSync(shim, "@echo off\r\nexit /b 93\r\n");
		const baseline = spawnSync(shim, ["--version"], {
			shell: false,
			encoding: "utf8",
		});
		assert.equal(baseline.error?.code, "EINVAL");
		const packageRoot = join(root, "cli");
		mkdirSync(packageRoot);
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({ name: "@namzu/cli", version: "1.2.3", type: "module" }),
		);
		for (const [name, source] of Object.entries(modules)) {
			const path = join(packageRoot, "dist", name);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, source);
		}

		async function exercise(packageRoot, expectedNode, root) {
			const assert = (await import("node:assert/strict")).default;
			const { join } = await import("node:path");
			const { pathToFileURL } = await import("node:url");
			const { spawnSync } = await import("node:child_process");
			const load = (name) =>
				import(pathToFileURL(join(packageRoot, "dist", `${name}.js`)));
			assert.equal(process.execPath.toLowerCase(), expectedNode.toLowerCase());
			const { resolveNpmInvocation } = await load(
				"integrations/npm-invocation",
			);
			const { runSetupCommand, installHarness, SETUP_HARNESSES } = await load(
				"integrations/providers/setup",
			);
			const { runNpmUpgrade } = await load("commands/upgrade");
			const args = [
				"install",
				"--global",
				"--prefix",
				join(root, "a & b %PATH% !"),
				"@namzu/cli@1.2.3",
			];
			const invocation = resolveNpmInvocation("npm.cmd", args);
			const direct = spawnSync(invocation.executable, [...invocation.args], {
				shell: false,
				encoding: "utf8",
			});
			assert.equal(direct.status, 0);
			assert.deepEqual(JSON.parse(direct.stdout), args);
			const setup = await installHarness(SETUP_HARNESSES[1], {
				cwd: root,
				signal: new AbortController().signal,
				onOutput: () => {},
			});
			assert.equal(setup.code, 0);
			assert.deepEqual(JSON.parse(setup.output), [
				"install",
				"--global",
				"@anthropic-ai/claude-code",
			]);
			let output = "";
			const upgradeCode = await runNpmUpgrade({
				executable: "npm.cmd",
				args,
				prefix: root,
				onOutput: (text) => {
					output += text;
				},
			});
			assert.equal(upgradeCode, 0);
			assert.deepEqual(JSON.parse(output), args);
			const controller = new AbortController();
			let childPid;
			const stopped = await runSetupCommand("npm", ["--hold-tree"], {
				cwd: root,
				signal: controller.signal,
				timeoutMs: 5000,
				onOutput: (text) => {
					if (childPid === undefined && text.includes("\n")) {
						childPid = JSON.parse(text).child;
						controller.abort();
					}
				},
			});
			assert.ok(childPid);
			assert.equal(stopped.code, null);
			assert.throws(
				() => process.kill(childPid, 0),
				(error) => error.code === "ESRCH",
			);
			const savedSystemRoot = process.env.SystemRoot;
			try {
				const failedStop = new AbortController();
				await assert.rejects(
					runSetupCommand("npm", ["--hold-one"], {
						cwd: root,
						signal: failedStop.signal,
						timeoutMs: 5000,
						onOutput: (text) => {
							if (text.includes("ready")) {
								process.env.SystemRoot = join(root, "missing-system-tools");
								failedStop.abort();
							}
						},
					}),
					/could not confirm that all installer child processes stopped/,
				);
			} finally {
				process.env.SystemRoot = savedSystemRoot;
			}
			let pipeHolderPid;
			let observationTimer;
			let timeoutOutcome;
			const failedTimeout = runSetupCommand("npm", ["--hold-tree"], {
				cwd: root,
				signal: new AbortController().signal,
				timeoutMs: 1000,
				onOutput: (text) => {
					if (pipeHolderPid === undefined && text.includes("\n")) {
						pipeHolderPid = JSON.parse(text).child;
						process.env.SystemRoot = join(root, "missing-system-tools");
					}
				},
			}).then(
				() => ({ kind: "resolved" }),
				(error) => ({ kind: "rejected", error }),
			);
			try {
				timeoutOutcome = await Promise.race([
					failedTimeout,
					new Promise((resolve) => {
						observationTimer = setTimeout(
							() => resolve({ kind: "pending" }),
							3000,
						);
					}),
				]);
				assert.ok(pipeHolderPid);
				// Failed taskkill cannot claim that this descendant stopped. The
				// fixture owns it and explicitly releases it after observing the result.
				assert.doesNotThrow(() => process.kill(pipeHolderPid, 0));
			} finally {
				clearTimeout(observationTimer);
				process.env.SystemRoot = savedSystemRoot;
				if (pipeHolderPid !== undefined) {
					try {
						process.kill(pipeHolderPid, "SIGKILL");
					} catch (error) {
						assert.equal(error.code, "ESRCH");
					}
				}
				await failedTimeout;
			}
			assert.equal(
				timeoutOutcome.kind,
				"rejected",
				"timeout must settle while a descendant holds inherited output pipes",
			);
			assert.match(
				timeoutOutcome.error.message,
				/could not confirm that all installer child processes stopped/,
			);
			assert.throws(
				() =>
					resolveNpmInvocation(
						"npm",
						args,
						"win32",
						join(root, "absent", "node.exe"),
					),
				/Repair that Node installation/,
			);
			console.log(
				JSON.stringify(
					{
						date: "2026-09-11",
						platform: process.platform,
						node: process.version,
						checks: {
							originalCmdEinvalReproduced: true,
							literalArgumentsPreserved: true,
							setupInstallerRouted: true,
							upgradePrefixPreserved: true,
							cancelledInstallerTreeStopped: true,
							failedCleanupReported: true,
							timeoutWithInheritedPipesRejected: true,
							failedCleanupDidNotClaimDescendantsStopped: true,
							missingBundleDiagnostic: true,
						},
						boundary:
							"Native Windows Node executes repository modules with an isolated synthetic npm-cli.js beside a temporary copy of Node. No real npm installation, upgrade, login, or provider call occurred.",
					},
					null,
					2,
				),
			);
		}
		const script = `(${exercise.toString()})(${JSON.stringify(packageRoot)},${JSON.stringify(node)},${JSON.stringify(root)}).catch(error=>{console.error(error);process.exitCode=1})`;
		return execFileSync(node, ["--input-type=module"], {
			input: script,
			encoding: "utf8",
			timeout: 20000,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const nativeNode =
	process.argv[2] ??
	(process.platform === "win32"
		? process.execPath
		: "/mnt/c/Program Files/nodejs/node.exe");
const script = `(${nativeCheck.toString()})(${JSON.stringify(modules)}).then(output=>process.stdout.write(output)).catch(error=>{console.error(error);process.exitCode=1})`;
process.stdout.write(
	execFileSync(nativeNode, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		timeout: 30000,
	}),
);
