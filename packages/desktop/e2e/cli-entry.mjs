// NAMZU_DESKTOP_CLI for the e2e world: patch fetch so the chat-completions driver talks to
// the scripted local server, then hand over to the real CLI. Electron strips
// NODE_OPTIONS from its own environment, so a --require preload cannot be used.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
createRequire(import.meta.url)("./redirect-fetch.cjs");
const bin = join(here, "../../cli/dist/bin.js");
await import(pathToFileURL(bin).href);
