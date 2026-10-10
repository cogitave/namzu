// NAMZU_DESKTOP_CLI for the e2e world: patch fetch so the chat-completions driver talks to
// the scripted local server, then hand over to the real CLI. Electron strips
// NODE_OPTIONS from its own environment, so a --require preload cannot be used.
import { createRequire, register } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
createRequire(import.meta.url)("./redirect-fetch.cjs");
// A flow that needs a Pal computer on a machine with no container engine asks for a stand-in:
// the optional sandbox package is answered by a small module whose guest is a recorder. Nothing
// else about the CLI changes; without the variable the real package is used.
if (process.env.NAMZU_E2E_PAL_COMPUTER === "fake")
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
const bin = join(here, "../../cli/dist/bin.js");
await import(pathToFileURL(bin).href);
