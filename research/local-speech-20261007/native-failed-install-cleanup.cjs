'use strict';
// Roll back only this task's failed pre-manifest CPU installation, with no user data.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
assert.equal(process.platform,'win32');
const root=path.join(process.env.APPDATA,'Namzu','local-speech');
const name='runtime-5c9f48b3-ad8d-4cfa-8359-2b645efae2fe';
const target=path.join(root,name);
const installation=JSON.parse(fs.readFileSync(path.join(root,'installation.json')));
assert.notEqual(installation.runtimeDirectory,name);
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(target,'worker.py'))).digest('hex'),'21b2a73dfe79ac3718bc88b25d93be5d56a17a71695682cc4e4c01eb3f4e6838');
assert.deepEqual(fs.readdirSync(target).sort(),['constraints.txt','models','venv','wheels','worker.py']);
assert.deepEqual(fs.readdirSync(path.join(target,'models')),[]);
assert.equal(fs.readFileSync(path.join(target,'constraints.txt'),'utf8'),'torch==2.14.1+cpu\nnumpy==2.5.3\nhuggingface-hub==2.1.1\nnormalizer-tr==0.4.0\n');
const canonical=fs.realpathSync(target), entries=[];
let bytes=0;
function scan(file,depth=0) {
 assert(depth<32 && entries.length<100000);
 const stat=fs.lstatSync(file);
 assert(!stat.isSymbolicLink());
 const real=fs.realpathSync(file), relative=path.relative(canonical,real);
 assert(relative==='' || (!relative.startsWith('..') && !path.isAbsolute(relative)));
 if(stat.isDirectory()) for(const name of fs.readdirSync(file)) scan(path.join(file,name),depth+1);
 else {assert(stat.isFile());bytes+=stat.size;}
 entries.push({file,directory:stat.isDirectory()});
}
scan(target);
for(const entry of entries) entry.directory?fs.rmdirSync(entry.file):fs.unlinkSync(entry.file);
assert(!fs.existsSync(target));
assert.equal(JSON.parse(fs.readFileSync(path.join(root,'installation.json'))).runtimeDirectory,installation.runtimeDirectory);
console.log(JSON.stringify({removedOnlyFailedTaskStage:true,bytes,entries:entries.length,currentInstallationPreserved:true}));
