const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.join(process.env.LOCALAPPDATA,'Namzu','Development');
const config=JSON.parse(fs.readFileSync(path.join(root,'launch.json'),'utf8'));
const source=process.argv[2]; const stamp=new Date().toISOString().replace(/[-:.]/g,'');
const out={stamp};
const q=v=>"'"+v.replaceAll("'","''")+"'";
const r=cp.spawnSync('powershell.exe',['-NoProfile','-Command',`@(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -eq ${q(config.electron)} }).Count; exit 0`],{encoding:'utf8',windowsHide:true});
out.runningElectron=Number(r.stdout.trim()); if(out.runningElectron!==0){console.log(JSON.stringify({...out,refused:'app is running'}));process.exit(1)}
const walk=(d,b='')=>fs.readdirSync(path.join(d,b),{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(d,path.join(b,e.name)):[path.join(b,e.name).replaceAll('\\','/')]);
const manifest=d=>crypto.createHash('sha256').update(walk(d).sort().map(f=>f+':'+crypto.createHash('sha256').update(fs.readFileSync(path.join(d,f))).digest('hex')).join('\n')).digest('hex');
const src=path.join(source,'desktop-dist'); const target=path.join(config.app,'dist');
const stage=path.join(config.app,`dist-stage-${stamp}`), backup=path.join(config.app,`dist-before-offline-${stamp}`);
for(const m of JSON.parse(fs.readFileSync(path.join(source,'desktop-modules','manifest.json'),'utf8'))){
  const p=path.join(config.app,'node_modules',m.name,'package.json');
  const v=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')).version:null;
  if(v!==m.version){console.log(JSON.stringify({...out,refused:`module ${m.name} installed ${v} wanted ${m.version}`}));process.exit(1)}
}
out.modules='all present at the build versions';
out.sourceManifest=manifest(src);
fs.cpSync(src,stage,{recursive:true});
if(manifest(stage)!==out.sourceManifest){fs.rmSync(stage,{recursive:true});console.log(JSON.stringify({...out,refused:'stage differs'}));process.exit(1)}
fs.renameSync(target,backup);
try{fs.renameSync(stage,target)}catch(e){fs.renameSync(backup,target);throw e}
out.installedManifest=manifest(target); out.equal=out.installedManifest===out.sourceManifest; out.backup=path.basename(backup);
console.log(JSON.stringify(out,null,1));
