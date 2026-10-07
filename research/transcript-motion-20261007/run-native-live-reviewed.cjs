"use strict";
// Owner invocation after reviewing the bounded single-prompt driver. A file
// entry point avoids unsupported Python -> Windows inline-command interop.
const assert = require("node:assert/strict");
const path = require("node:path");
assert.equal(process.platform, "win32");
assert.deepEqual(process.argv.slice(2), ["--confirm-single-free-prompt"]);
process.env.NAMZU_NATIVE_LIVE_PROOF = "1";
const driver = path.join(__dirname, "native-live-proof.cjs");
process.argv = [process.execPath, driver, "--execute", "--chat-project-id=3b950ddf-ba7f-4a6d-bac4-ea5930022f8c"];
require(driver);
