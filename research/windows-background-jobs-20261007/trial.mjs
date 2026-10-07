import {pathToFileURL} from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import {execSync} from 'node:child_process'
const [,, label, sdkIndex, baseDir] = process.argv
const sdk = await import(pathToFileURL(sdkIndex).href)
const {BackgroundJobRegistry, bindOwner} = sdk
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pings = () => { try { return (execSync('tasklist /FI "IMAGENAME eq ping.exe" /NH', {encoding:'utf8'}).match(/ping\.exe/gi)||[]).length } catch(e){ return -1 } }
const cases = [
 ['1-ping6', 'ping -n 6 127.0.0.1'],
 ['2-forloop', 'for /l %i in (1,1,5) do @(echo Adim %i/5 tamamlandi & ping -n 3 127.0.0.1 >nul)'],
 ['3-redirect', 'cmd /c "for /l %i in (1,1,3) do @(echo Adim %i/3 & ping -n 2 127.0.0.1 >nul)" > bg-demo.txt 2>&1'],
 ['4-powershell', 'powershell -NoProfile -Command "foreach($i in 1..3){Write-Output (\'tick \'+$i); Start-Sleep -Seconds 1}"'],
 ['5-kill', 'ping -n 60 127.0.0.1', {kill:true}],
 ['6-nonexistent', 'definitely-not-a-real-exe-xyz --flag'],
 ['6b-baddir', 'echo hi', {badDir:true}],
 ['7-turkish', 'echo çğıöşü'],
 ['8-quoting', 'echo "a & b" & echo 100%% !x! ^& done', {diff:true}],
 ['9-exitcode', 'echo before & exit /b 7', {diff:true}],
 ['10-pipe', 'echo hello | findstr /c:"hel" & echo "q|r" > q.txt & type q.txt', {diff:true}],
 ['11-env-percent', 'echo %COMSPEC% %NOPE% %CD%', {diff:true}],
]
// Differential: what the platform's own `spawn(command, {shell:true})` (what the foreground tool ran before) prints.
import {spawnSync} from 'node:child_process'
const direct = (command, cwd) => { const r = spawnSync(command, {shell:true, cwd, windowsHide:true, encoding:'latin1'}); return {out: r.stdout, code: r.status} }
const receipt = {label, sdkIndex, node: process.version, cases: {}}
for (const [name, command, opt={}] of cases) {
  const cwd = path.join(baseDir, label + '-' + name); fs.mkdirSync(cwd, {recursive:true})
  const reg = new BackgroundJobRegistry(); const ref = bindOwner(reg, 'trial', {workingDirectory: cwd})
  const t0 = Date.now(); const rec = {command}
  try {
    const job = ref.start(opt.badDir ? {command, workingDirectory: path.join(cwd,'nope')} : {command})
    rec.startedStatus = job.status
    if (ref.awaitStarted) { const s = await ref.awaitStarted(job.id); rec.awaitStarted = s }
    let off = 0, firstOut = null, lines = []
    const poll = async () => { const r = ref.read(job.id,{fromOffset:off}); off = r.nextOffset; if (r.chunk) { if (firstOut===null) firstOut = Date.now()-t0; lines.push([Date.now()-t0, r.chunk]) } return r }
    let killed = false
    if (opt.kill) { rec.pingsBefore = pings(); await sleep(3000); rec.statusAt3s = ref.get(job.id).status; rec.pingsRunning = pings(); await poll(); const k = await ref.kill(job.id); killed = true; await sleep(1500); rec.pingsAfter = pings() }
    let done = false
    const wait = ref.waitForExit(job.id).then(()=>{done=true})
    while (!done && Date.now()-t0 < 90000) { await Promise.race([wait, sleep(250)]); await poll() }
    await poll()
    const j = ref.get(job.id); const out = ref.read(job.id)
    Object.assign(rec, {elapsedMs: Date.now()-t0, status: j.status, exitCode: j.exitCode, signal: j.signal, error: j.error, firstOutputMs: firstOut, output: out.chunk, outputHexNonAscii: [...out.chunk].some(c=>c.charCodeAt(0)>127) ? Buffer.from(out.chunk,'utf8').toString('hex') : undefined, chunkTimes: lines.map(l=>l[0])})
    if (opt.diff) { const d = direct(command, cwd); rec.direct = d; rec.sameAsDirect = d.out === out.chunk && d.code === j.exitCode }
    if (name==='3-redirect') { const f = path.join(cwd,'bg-demo.txt'); rec.fileExists = fs.existsSync(f); rec.fileContent = rec.fileExists ? fs.readFileSync(f).toString('latin1') : null }
  } catch (e) { rec.thrown = String(e && e.stack || e) }
  receipt.cases[name] = rec
  console.log(label, name, JSON.stringify({el:rec.elapsedMs, st:rec.status, ec:rec.exitCode, err:rec.error, out:rec.output, same:rec.sameAsDirect, direct:rec.direct, thrown:rec.thrown, pings:[rec.pingsBefore,rec.pingsRunning,rec.pingsAfter], file:rec.fileExists}))
}
fs.writeFileSync(path.join(baseDir, 'receipt-'+label+'.json'), JSON.stringify(receipt,null,2))
