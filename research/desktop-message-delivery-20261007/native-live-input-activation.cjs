"use strict";
// Extend the pinned activation guard for exactly the three live-input CLI modules.
// The inherited Desktop/state/process/dependency/SDK protections remain intact.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const adapter = path.resolve(__dirname, "../desktop-autonomy-20261007/native-recorded-work-activation.cjs");
const bytes = fs.readFileSync(adapter);
assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"),
  "e67f69b405fd5792a40ef179e74719b522b4cc8eec8901e16f9d5d9a51e5928b",
  "Review the inherited adapter before applying this bounded update.");
assert(!process.argv.some(arg => ["--desktop-only", "--claude-protocol-only"].includes(arg)),
  "This adapter has one exact reviewed runtime set.");
let source = bytes.toString("utf8");
function replaceOnce(before, after) {
  assert.equal(source.split(before).length, 2, "The reviewed activation seam changed.");
  source = source.replace(before, after);
}
replaceOnce(
  'const changedRuntimeSet =\n\truntimeMode === "--desktop-only"\n\t\t? []\n\t\t: runtimeMode === "--claude-protocol-only"\n\t\t\t? ["cli/integrations/harness/claude-protocol.js"]\n\t\t\t: ["cli/commands/desktop-host.js"];',
  'const changedRuntimeSet = ["cli/commands/acp-harness.js", "cli/commands/acp.js", "cli/commands/desktop-host.js"];',
);
// acp.js is already shipped. Its only additional runtime import is Node's UUID
// function; no package or generated module is introduced into the native graph.
replaceOnce(
  "const inherited = new Module(original, module);",
  "replaceOnce(\"const sourceOptions = [\\n\", \"const sourceOptions = [\\n\" +\n" +
  "  \"  { option: '--cli-live-input-source=', kind: 'cli', file: 'commands/acp.js', label: 'LivePromptInput', additions: new Map([['node:crypto', ['randomUUID']]]), allowedAbsentImports: new Set(['node:crypto']), addedExports: [] },\\n\");\n" +
  "const inherited = new Module(original, module);",
);
const inherited = new Module(adapter, module);
inherited.filename = adapter;
inherited.paths = Module._nodeModulePaths(path.dirname(adapter));
inherited._compile(source, adapter);
