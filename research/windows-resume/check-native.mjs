// Native PowerShell handoff test with synthetic argv. No CLI/provider is launched.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const sources = Object.fromEntries(
	["exit-summary", "terminal-display"].map((name) => [
		name,
		ts.transpileModule(
			readFileSync(
				new URL(`../../packages/cli/src/tui/${name}.ts`, import.meta.url),
				"utf8",
			),
			{
				compilerOptions: {
					module: ts.ModuleKind.ES2022,
					target: ts.ScriptTarget.ES2022,
				},
			},
		).outputText,
	]),
);

async function nativeCheck(sources) {
	const assert = (await import("node:assert/strict")).default;
	const { execFileSync, spawnSync } = await import("node:child_process");
	const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import(
		"node:fs"
	);
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { pathToFileURL } = await import("node:url");
	assert.equal(process.platform, "win32");
	const powershell = join(
		process.env.SystemRoot,
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	const flags = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"];
	const root = mkdtempSync(join(tmpdir(), "namzu resume's & [fixture] "));
	try {
		writeFileSync(join(root, "package.json"), '{"type":"module"}');
		for (const [name, source] of Object.entries(sources))
			writeFileSync(join(root, `${name}.js`), source);
		const { formatTuiExitSummary } = await import(
			pathToFileURL(join(root, "exit-summary.js"))
		);
		const cwd = join(root, "project's [work] $(Write-Output WRONG)");
		mkdirSync(cwd);
		const entry = join(root, "entry's & [args].cjs");
		writeFileSync(
			entry,
			"process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))",
		);
		const id = "ses_'$() & ` %PATH% !";
		const command = (invocation) => {
			const line = formatTuiExitSummary({ conversationId: id }, invocation);
			assert.ok(
				line.startsWith("To resume this conversation, run in PowerShell: "),
			);
			return line
				.slice("To resume this conversation, run in PowerShell: ".length)
				.trimEnd();
		};
		const baseline = spawnSync(
			powershell,
			[...flags, `'${process.execPath}' --version`],
			{ encoding: "utf8" },
		);
		assert.notEqual(baseline.status, 0);
		const changed = spawnSync(
			powershell,
			[...flags, command({ cwd, command: [process.execPath, entry] })],
			{ encoding: "utf8" },
		);
		assert.equal(changed.status, 0);
		assert.deepEqual(JSON.parse(changed.stdout), { cwd, args: ["resume", id] });
		const same = spawnSync(
			powershell,
			[
				...flags,
				command({ cwd: process.cwd(), command: [process.execPath, entry] }),
			],
			{ encoding: "utf8" },
		);
		assert.equal(same.status, 0);
		assert.deepEqual(JSON.parse(same.stdout), {
			cwd: process.cwd(),
			args: ["resume", id],
		});
		const missing = spawnSync(
			powershell,
			[
				...flags,
				command({
					cwd: join(root, "missing"),
					command: [process.execPath, entry],
				}),
			],
			{ encoding: "utf8" },
		);
		assert.equal(missing.stdout, "");
		assert.ok(missing.stderr.length > 0);
		return {
			date: "2026-09-11",
			platform: process.platform,
			node: process.version,
			powershell: execFileSync(
				powershell,
				[...flags, "$PSVersionTable.PSVersion.ToString()"],
				{ encoding: "utf8" },
			).trim(),
			checks: {
				originalQuotedExecutableRejected: true,
				handoffNamesPowerShell: true,
				quotedExecutableAndArgvPreserved: true,
				literalDirectoryChangeSucceeded: true,
				sameDirectoryInvocationSucceeded: true,
				failedDirectoryChangeDoesNotLaunch: true,
			},
			boundary:
				"Repository formatter executed with native Windows Node and Windows PowerShell against temporary synthetic scripts and paths. No CLI conversation, provider, login, installation, or upgrade was run.",
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const nativeNode =
	process.argv[2] ??
	(process.platform === "win32"
		? process.execPath
		: "/mnt/c/Program Files/nodejs/node.exe");
const script = `(${nativeCheck.toString()})(${JSON.stringify(sources)}).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error);process.exitCode=1})`;
process.stdout.write(
	execFileSync(nativeNode, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		timeout: 30000,
	}),
);
