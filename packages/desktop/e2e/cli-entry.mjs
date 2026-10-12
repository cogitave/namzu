// NAMZU_DESKTOP_CLI for the e2e world: patch fetch so the chat-completions driver talks to
// the scripted local server, then hand over to the real CLI. Electron strips
// NODE_OPTIONS from its own environment, so a --require preload cannot be used.
import { existsSync, watch, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { basename, dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
// A flow that walks the Pal computer row through its setup states answers `namzu computer ...` from a
// script instead of an engine. Only that command is answered; everything else is the real CLI.
if (process.argv[2] === "computer" && process.env.NAMZU_E2E_COMPUTER_SCRIPT) {
	const { runComputerStandIn } = await import("./computer-stand-in.mjs");
	await runComputerStandIn(process.argv.slice(3), process.env.NAMZU_E2E_COMPUTER_SCRIPT);
	process.exit(0);
}
createRequire(import.meta.url)("./redirect-fetch.cjs");
// A flow that needs a Pal computer on a machine with no container engine asks for a stand-in:
// the optional sandbox package is answered by a small module whose guest is a recorder. Nothing
// else about the CLI changes; without the variable the real package is used.
if (process.env.NAMZU_E2E_PAL_COMPUTER === "fake" || process.env.NAMZU_E2E_PAL_COMPUTER === "fake-fails")
	register(pathToFileURL(join(here, "fake-pal-computer-hooks.mjs")).href);
// A flow that needs a slow answer asks for it: the first per-conversation provider read is held back, as
// a busy machine holds it, so a change of model made meanwhile overtakes it. Nothing else changes.
const holdMs = Number(process.env.NAMZU_E2E_HOLD_FIRST_PROVIDER_READ_MS ?? 0);
if (holdMs > 0) {
	let held = false;
	const emit = process.stdin.emit.bind(process.stdin);
	process.stdin.emit = (event, ...args) => {
		const text = event === "data" ? String(args[0]) : "";
		if (!held && /namzu\/providers\/status/.test(text) && /sessionId/.test(text)) {
			held = true;
			setTimeout(() => emit(event, ...args), holdMs);
			return true;
		}
		return emit(event, ...args);
	};
}
// A flow that needs projects to answer at times it controls asks for gates: a request for this
// folder's connection status (`connect`) or conversation list (`list`) waits while the file
// `<gate dir>/<folder>.<kind>.hold` exists, and goes through the moment the flow deletes it. The
// wait is a file-system event, never a timer. `.held` and `.done` files tell the flow where the
// request is. Nothing else changes.
const gateDir = process.env.NAMZU_E2E_GATE_DIR;
if (gateDir) {
	const folder = basename(process.cwd());
	const kinds = { connect: /namzu\/project\/status/, list: /namzu\/conversations\/list/ };
	const emit = process.stdin.emit.bind(process.stdin);
	process.stdin.emit = (event, ...args) => {
		const text = event === "data" ? String(args[0]) : "";
		for (const [kind, pattern] of Object.entries(kinds)) {
			const hold = join(gateDir, `${folder}.${kind}.hold`);
			if (!pattern.test(text) || !existsSync(hold)) continue;
			// Watching starts before the request is announced, so a release cannot slip past it.
			let released = false;
			const release = () => {
				if (released || existsSync(hold)) return;
				released = true;
				watcher.close();
				writeFileSync(join(gateDir, `${folder}.${kind}.done`), "");
				emit(event, ...args);
			};
			const watcher = watch(gateDir, release);
			writeFileSync(join(gateDir, `${folder}.${kind}.held`), "");
			release();
			return true;
		}
		return emit(event, ...args);
	};
}
const bin = join(here, "../../cli/dist/bin.js");
await import(pathToFileURL(bin).href);
