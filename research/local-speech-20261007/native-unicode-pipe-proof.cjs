"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
assert.equal(process.platform, "win32");
const root = path.join(process.env.APPDATA, "Namzu", "local-speech");
const installation = JSON.parse(fs.readFileSync(path.join(root, "installation.json")));
assert(/^runtime-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(installation.runtimeDirectory));
const python = path.join(root, installation.runtimeDirectory, "venv/Scripts/python.exe");
const text = "Merhaba! Ben Namzu. Türkçe seslendirme bu cihazda çalışıyor.";
const output = path.join(__dirname, "artifacts/native-unicode-pipe-proof.json");
assert(!fs.existsSync(output));
const probe = args => {
  const child = cp.spawnSync(python, [...args, "-u", "-c", "import sys,json; value=json.loads(sys.stdin.readline()); print(json.dumps({'encoding':sys.stdin.encoding,'text':value['text']},ensure_ascii=True))"], {
    encoding:"utf8", input: JSON.stringify({text})+"\n", windowsHide:true,
  });
  assert.equal(child.status,0,child.stderr);
  return JSON.parse(child.stdout);
};
const original = probe(["-I"]);
const corrected = probe(["-I", "-X", "utf8"]);
assert.equal(corrected.text,text);
const receipt = {passed:true,platform:process.platform,at:new Date().toISOString(),fixedSampleOnly:true,original,corrected,originalPreservedUnicode:original.text===text,correctedPreservedUnicode:true};
fs.writeFileSync(output, JSON.stringify(receipt,null,2)+"\n", {flag:"wx"});
console.log(JSON.stringify(receipt));
