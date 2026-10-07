"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
assert.equal(process.platform, "win32");
const directory = path.join(process.env.APPDATA, "Namzu", "local-speech");
const manifest = JSON.parse(fs.readFileSync(path.join(directory, "installation.json")));
assert.equal(manifest.modelRevision, "7a6ba1ad216bb2f1da9863f80ac8770a6a807632");
assert.equal(manifest.workerSha256, "21b2a73dfe79ac3718bc88b25d93be5d56a17a71695682cc4e4c01eb3f4e6838");
assert(/^runtime-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(manifest.runtimeDirectory));
const runtime = path.join(directory, manifest.runtimeDirectory);
const output = path.join(__dirname, "artifacts/native-sample-rate-proof.json");
assert(!fs.existsSync(output), "Keep the original diagnostic receipt.");
const child = cp.spawnSync(path.join(runtime, "venv/Scripts/python.exe"), ["-I", path.join(__dirname, "native-sample-rate-proof.py"), runtime], {
  encoding: "utf8", windowsHide: true,
  env: {...process.env, HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", CUDA_VISIBLE_DEVICES: "", PYTHONNOUSERSITE: "1"},
});
assert.equal(child.status, 0, child.stderr);
const receipt = JSON.parse(child.stdout.trim());
assert.equal(receipt.passed, true);
fs.writeFileSync(output, JSON.stringify({...receipt, platform: process.platform, at: new Date().toISOString(), providerRequests: 0}, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(receipt));
