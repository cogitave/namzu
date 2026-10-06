'use strict';
// Reuse the immutable, previously audited native activation guard. This adapter
// changes only its exact reviewed module set and one removed named import.
// Invocation and all ownership/state/graph checks are inherited verbatim.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const original = path.resolve(__dirname,
  '../runtime-desktop-20260930/transcript-content-desktop-activation-native-20261007.cjs');
const bytes = fs.readFileSync(original);
assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),
  'f85cd8f55dd95cd76ffdbfc166d15410d383470f7c6fd3296cfb8dee4693e56d',
  'The inherited guard changed; review it before applying this adapter.');
let code = bytes.toString('utf8');
function replaceOnce(before, after) {
  assert.equal(code.split(before).length, 2, 'The reviewed guard seam changed.');
  code = code.replace(before, after);
}
replaceOnce("const expectedChangedRuntimeSet = [\n  'cli/commands/desktop-host.js',\n  'cli/integrations/harness/claude-protocol.js',\n  'cli/integrations/sessions/store.js',\n];",
  "const expectedChangedRuntimeSet = ['cli/commands/desktop-host.js'];");
replaceOnce("    assert.deepEqual(nextNames.filter(name => !additions.includes(name)), previousNames.filter(name => !additions.includes(name)),\n      `Import changed beyond reviewed additions in ${item.file}.`);",
  "    const removedHistoryReader = name => item.file === 'commands/desktop-host.js' && specifier === '../integrations/sessions/store.js' && name === 'loadConversation';\n" +
  "    if (previousNames.some(removedHistoryReader)) assert(!nextNames.includes('loadConversation'), 'The replaced history reader remains imported.');\n" +
  "    assert.deepEqual(nextNames.filter(name => !additions.includes(name)), previousNames.filter(name => !additions.includes(name) && !removedHistoryReader(name)),\n" +
  "      `Import changed beyond reviewed additions and the removed history reader in ${item.file}.`);");
replaceOnce("'eight reviewed modules; only desktop-host, Claude protocol and session store may change'",
  "'eight reviewed modules; only CLI desktop-host may change; SDK byte exact'");
// Preserve every original receipt and the original helper. No graph, authority,
// message, profile, computer, draft, presentation or action check is loosened.
const inherited = new Module(original, module);
inherited.filename = original;
inherited.paths = Module._nodeModulePaths(path.dirname(original));
inherited._compile(code, original);
