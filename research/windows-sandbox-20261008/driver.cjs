// Sandbox-side driver. Runs under the INSTALLED app's own Electron as plain Node
// (ELECTRON_RUN_AS_NODE=1), so the clean machine needs no Node. It drives the installed app over
// raw CDP and writes one JSON receipt per check into C:\out. Receipts hold counts, hashes,
// timings and error text only; no conversation text.
const { spawn, execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const OUT = 'C:\\out'
const installDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'Namzu')
const exe = path.join(installDir, 'Namzu.exe')
const userData = path.join(process.env.APPDATA, 'Namzu')
// This process is a copy of the installed Electron (C:\drv), so the installer can replace and stop the real Namzu.exe.
const WebSocket = require(path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'node_modules', 'ws'))
const PORT = 9347
const FEED_PORT = 8099
process.on('exit', (c) => console.log(new Date().toISOString(), 'driver exit', c))
process.on('uncaughtException', (e) => console.log('uncaught', String(e && e.stack || e)))
process.on('unhandledRejection', (e) => console.log('unhandled', String(e && e.stack || e)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString(), ...a)
const receipt = (name, obj) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 2))
const ps = (file, ...args) =>
	execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { encoding: 'utf8' }).trim()
const screen = (name) => { try { ps('C:\\in\\shot.ps1', path.join(OUT, name)) } catch (e) { log('screen shot failed', String(e).slice(0, 200)) } }
const get = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(b)) }).on('error', rej))
const exeVersion = () => execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item '${exe}').VersionInfo.ProductVersion`], { encoding: 'utf8' }).trim()
// The driver itself runs as Namzu.exe (Electron as Node), so every process lookup excludes its own pid.
const namzuPidList = () => execFileSync('powershell.exe', ['-NoProfile', '-Command', "@(Get-Process Namzu -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) -join ','"], { encoding: 'utf8' }).trim().split(',').filter((x) => x && Number(x) !== process.pid)
const namzuPids = () => namzuPidList().join(',')
const killApp = () => { for (const pid of namzuPidList()) { try { execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' }) } catch {} } }

async function step(file, check, fn) {
	const t0 = Date.now()
	log('start', check)
	let r
	try { r = await fn() } catch (e) { r = { result: 'fail', error: String((e && e.stack) || e).slice(0, 1500) } }
	r = { check, ...r, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0 }
	receipt(file, r)
	log('end', check, r.result)
	return r
}

function launch(env, label) {
	const e = { ...process.env, ...env }
	delete e.ELECTRON_RUN_AS_NODE
	const out = fs.openSync(path.join(OUT, `app-${label}.log`), 'w')
	const child = spawn(exe, [`--remote-debugging-port=${PORT}`], { env: e, stdio: ['ignore', out, out], detached: false })
	child.on('exit', (c, sig) => log('app', label, 'exited', c, sig))
	child.on('error', (e) => log('app', label, 'spawn error', String(e)))
	log('app', label, 'started pid', child.pid)
	return child
}

async function connect(timeoutMs = 90_000) {
	const t0 = Date.now()
	let page
	while (Date.now() - t0 < timeoutMs) {
		try {
			const list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`))
			page = list.find((t) => t.type === 'page')
			if (page) break
		} catch {}
		await sleep(500)
	}
	if (!page) throw new Error('no page target within ' + timeoutMs + ' ms')
	const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
	await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
	let id = 0
	const pend = new Map()
	ws.on('message', (m) => { const j = JSON.parse(m); if (j.id && pend.has(j.id)) { pend.get(j.id).r(j); pend.delete(j.id) } })
	ws.on('error', () => {})
	const failAll = (why) => { for (const [k, v] of pend) { v.j(new Error(why)); pend.delete(k) } }
	ws.on('close', () => failAll('connection closed'))
	const send = (method, params = {}) => new Promise((r, j) => {
		const i = ++id
		pend.set(i, { r, j })
		const timer = setTimeout(() => { if (pend.delete(i)) j(new Error('CDP timeout: ' + method)) }, 60_000)
		timer.unref?.()
		try { ws.send(JSON.stringify({ id: i, method, params })) } catch (e) { pend.delete(i); j(e) }
	})
	const evaluate = async (expression) => {
		const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
		if (r.error) throw new Error(JSON.stringify(r.error))
		if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
		return r.result.result.value
	}
	const shot = async (name) => {
		const r = await send('Page.captureScreenshot', { format: 'png' })
		if (r.result) fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'))
	}
	return { ws, send, evaluate, shot, msToPage: Date.now() - t0, url: page.url }
}

async function stopApp(cdp, child) {
	log('stopApp')
	cdp.send('Browser.close').catch(() => {}) // the app exits before it can answer
	try { cdp.ws.close() } catch {}
	for (let i = 0; i < 60 && namzuPids(); i++) await sleep(500)
	if (namzuPids()) killApp()
}

const dirBytes = (d) => { let n = 0; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); n += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size } } catch {} return n }

;(async () => {
	fs.mkdirSync('C:\\work\\fixture', { recursive: true })
	fs.writeFileSync('C:\\work\\fixture\\README.txt', 'sandbox fixture\n')
	fs.mkdirSync(userData, { recursive: true })
	// The native "Open a project" dialog cannot be driven over CDP, so the folder enters the app the
	// way a returning user's does: through the persisted project list the app restores on start.
	fs.writeFileSync(path.join(userData, 'projects.json'), JSON.stringify(['C:\\work\\fixture']))

	// ---------- run A: no update feed ----------
	const t0 = Date.now()
	const child = launch({}, 'A')
	let cdp, state = {}
	const first = await step('02-first-launch.json', 'first launch', async () => {
		cdp = await connect()
		await sleep(8000)
		const page = JSON.parse(await cdp.evaluate('JSON.stringify({title:document.title,textLength:document.body.innerText.length,rootChildren:document.getElementById("root")?.children.length,api:typeof window.namzu})'))
		await cdp.shot('02-first-launch.png')
		const projects = await cdp.evaluate('window.namzu.projects().then(p=>JSON.stringify(p.map(x=>({id:x.id,path:x.path,status:x.status,trusted:x.trusted,error:x.error}))))')
		const userDataEntries = fs.readdirSync(userData)
		return {
			result: page.title && page.title !== 'Error' && page.rootChildren > 0 && page.api === 'object' ? 'pass' : 'fail',
			msToWindow: cdp.msToPage, page, projects: JSON.parse(projects), userDataEntries,
			cliLogs: fs.readdirSync(path.join(process.env.USERPROFILE, '.namzu'), { recursive: false }).slice(0, 20),
		}
	})
	if (!cdp) { receipt('99-abort.json', { reason: 'no window' }); return }

	// ---------- open folder + trust ----------
	let project
	await step('03-open-folder-trust.json', 'open a folder and trust it', async () => {
		let list = []
		for (let i = 0; i < 40; i++) {
			list = JSON.parse(await cdp.evaluate('window.namzu.projects().then(p=>JSON.stringify(p))'))
			project = list.find((p) => p.path.toLowerCase().includes('fixture'))
			if (project && project.status !== 'connecting') break
			await sleep(1000)
		}
		if (!project) return { result: 'fail', error: 'fixture project never appeared', projects: list.map((p) => p.path) }
		const before = { status: project.status, trusted: project.trusted }
		let dialog = 'n/a'
		if (!project.trusted) {
			// The consent is an in-app dialog now: press "Review folder access" in the page, then "Allow folder access".
			const clickText = (re) => cdp.evaluate(`(()=>{ const b=[...document.querySelectorAll('button')].find(x=>${re}.test(x.innerText)); if(!b) return false; b.click(); return true })()`)
			const review = await clickText('/review folder access/i')
			await sleep(1200)
			await cdp.shot('03-trust-dialog.png')
			const allowed = await clickText('/^\\s*allow folder access\\s*$/i')
			dialog = { reviewClicked: review, allowClicked: allowed }
			if (!review || !allowed) {
				// Older builds asked through a native message box.
				cdp.evaluate(`window.__trust = window.namzu.trustProject(${JSON.stringify(project.id)}).catch(()=>0); 1`).catch(() => {})
				await sleep(2500)
				screen('03-trust-dialog-screen.png')
				try { dialog.native = ps('C:\\in\\click-dialog.ps1', 'Allow folder access?', '20') } catch (e) { dialog.native = 'failed: ' + String(e.stdout || e).slice(0, 200) }
			}
			await sleep(2000)
		}
		const after = JSON.parse(await cdp.evaluate('window.namzu.projects().then(p=>JSON.stringify(p))')).find((p) => p.id === project.id)
		await cdp.shot('03-after-trust.png')
		project = after
		return { result: after.status === 'ready' && after.trusted ? 'pass' : 'fail', before, dialog, after: { status: after.status, trusted: after.trusted, error: after.error } }
	})

	// ---------- Zen reply with no key ----------
	let session
	await step('04-zen-reply.json', 'free Zen reply without a key', async () => {
		if (!project) return { result: 'blocked', reason: 'no project' }
		const conv = JSON.parse(await cdp.evaluate(`window.namzu.newConversation(${JSON.stringify(project.id)}).then(c=>JSON.stringify(c))`))
		session = conv.id
		const prov = JSON.parse(await cdp.evaluate(`window.namzu.providers(${JSON.stringify(project.id)}, ${JSON.stringify(session)}).then(v=>JSON.stringify(v))`))
		const zen = prov.available.find((p) => /zen/i.test(p.id) || /zen/i.test(p.label))
		let models = null
		if (zen) {
			const cat = JSON.parse(await cdp.evaluate(`window.namzu.models(${JSON.stringify(project.id)}, ${JSON.stringify(zen.id)}, ${JSON.stringify(session)}).then(v=>JSON.stringify(v))`))
			const free = cat.models.find((m) => m.group === 'free') || cat.models.find((m) => m.default) || cat.models[0]
			models = { count: cat.models.length, free: cat.models.filter((m) => m.group === 'free').length, chosen: free && free.id }
			if (free) await cdp.evaluate(`window.namzu.selectProvider(${JSON.stringify(session)}, ${JSON.stringify(zen.id)}, ${JSON.stringify(free.id)})`)
		}
		await cdp.evaluate(`window.__ev=[]; window.namzu.onEvent(e=>{ if(e.sessionId===${JSON.stringify(session)}) window.__ev.push(e) }); 1`)
		await cdp.evaluate(`window.namzu.send(${JSON.stringify(session)}, 'Reply with the single word: ready').then(()=>1,e=>{window.__sendError=String(e&&e.message||e)}); 1`)
		let summary
		for (let i = 0; i < 90; i++) {
			await sleep(1000)
			summary = JSON.parse(await cdp.evaluate(`JSON.stringify({sendError:window.__sendError||null,kinds:window.__ev.map(e=>e.kind+(e.update?':'+(e.update.kind||''):'')),running:[...window.__ev].reverse().find(e=>e.kind==='state')?.running,err:window.__ev.filter(e=>e.kind==='state'&&e.error).map(e=>e.error)})`))
			if (summary.sendError || (summary.kinds.some((k) => k.startsWith('update:agent_message')) && summary.running === false) || (summary.err.length && summary.running === false)) break
		}
		const text = await cdp.evaluate(`window.__ev.filter(e=>e.kind==='update'&&e.update&&e.update.kind==='agent_message_chunk').map(e=>e.update.text||'').join('').length`)
		const updateErrors = JSON.parse(await cdp.evaluate(`JSON.stringify(window.__ev.filter(e=>e.kind==='update'&&e.update&&/error|fail|refus/i.test(JSON.stringify(Object.keys(e.update))+(e.update.kind||'')+(e.update.stopReason||''))).map(e=>({kind:e.update.kind,stopReason:e.update.stopReason,message:String(e.update.message||e.update.error||'').slice(0,300)})))`))
		await cdp.shot('04-zen.png')
		const counts = {}
		for (const k of summary.kinds) counts[k] = (counts[k] || 0) + 1
		const replied = text > 0
		return { result: replied ? 'pass' : 'blocked', provider: zen || prov.available.map((p) => p.id), selected: prov.selected, models, replyChars: text, eventCounts: counts, errors: summary.err, updateErrors, sendError: summary.sendError,
			note: replied ? 'Zen answered anonymously.' : 'No reply. If the errors name a refused or unauthorised gateway this is the gateway, not the installer.' }
	})

	// ---------- network probe from the same runtime the app uses (Node fetch inside Electron) ----------
	await step('04b-network.json', 'network reachability from the runtime', async () => {
		const targets = [
			['huggingface', 'https://huggingface.co/canberkkkkkk/ema-lightning/resolve/main/README.md'],
			['pypi', 'https://pypi.org/simple/numpy/'],
			['pytorch', 'https://download.pytorch.org/whl/cpu/'],
			['pythonhosted', 'https://files.pythonhosted.org/'],
		]
		const results = {}
		for (const [name, url] of targets) {
			const t = Date.now()
			try { const r = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20000) }); results[name] = { status: r.status, location: (r.headers.get('location') || '').slice(0, 120), ms: Date.now() - t }; await r.body?.cancel() } catch (e) { results[name] = { error: String(e), cause: String(e && e.cause && (e.cause.code || e.cause.message)), ms: Date.now() - t } }
		}
		{
			const t = Date.now()
			try {
				const r = await fetch('https://huggingface.co/canberkkkkkk/ema-lightning/resolve/7a6ba1ad216bb2f1da9863f80ac8770a6a807632/decoder.pt', { signal: AbortSignal.timeout(120000) })
				let n = 0
				const reader = r.body.getReader()
				for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.byteLength }
				results.modelFile = { status: r.status, bytes: n, finalHost: new URL(r.url).host, ms: Date.now() - t }
			} catch (e) { results.modelFile = { error: String(e), cause: String(e && e.cause && (e.cause.code || e.cause.message)), ms: Date.now() - t } }
		}
		return { result: 'info', results }
	})

	// ---------- speech ----------
	await step('05-speech.json', 'local speech with the bundled Python', async () => {
		const out = {}
		const st0 = JSON.parse(await cdp.evaluate('window.namzu.localSpeechState().then(s=>JSON.stringify(s))'))
		out.before = { installation: st0.installation, error: st0.error }
		const dirBefore = dirBytes(path.join(userData, 'local-speech'))
		const ti = Date.now()
		let st1
		try { st1 = JSON.parse(await cdp.evaluate('window.namzu.localSpeechInstall().then(s=>JSON.stringify(s))')) } catch (e) { return { result: 'fail', stage: 'install', error: String(e).slice(0, 800), ...out } }
		out.install = { ms: Date.now() - ti, installation: st1.installation, error: st1.error, runtimeDownloadBytes: st1.resources.runtimeDownloadBytes, modelDownloadBytes: st1.resources.modelDownloadBytes, diskBytes: st1.resources.diskBytes, localSpeechDirBytes: dirBytes(path.join(userData, 'local-speech')) - dirBefore }
		if (st1.installation !== 'ready') {
			// The app hides the subprocess output in its error text; repeat the first commands here to see it.
			const py = path.join(installDir, 'resources', 'python', 'python.exe')
			const run = (args, ms) => { const t = Date.now(); try { const o = execFileSync(py, args, { encoding: 'utf8', timeout: ms, stdio: ['ignore', 'pipe', 'pipe'] }); return { ok: true, ms: Date.now() - t, tail: o.slice(-300) } } catch (e) { return { ok: false, ms: Date.now() - t, tail: String((e.stderr || '') + (e.stdout || '') || e).slice(-900) } } }
			fs.rmSync('C:\\work\\replica', { recursive: true, force: true })
			out.replica = { version: run(['-I', '-c', 'import sys;print(sys.version)'], 30000), venv: run(['-I', '-m', 'venv', '--copies', 'C:\\work\\replica\\venv'], 120000) }
			if (out.replica.venv.ok) out.replica.pipDownload = run(['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', 'download', '--only-binary=:all:', '--dest', 'C:\\work\\replica\\w', '--index-url', 'https://download.pytorch.org/whl/cpu', 'torch==2.14.1+cpu'].map((x) => x), 600000)
			// Run the app's own installer module here with its fetch and file writes instrumented, to see the swallowed cause.
			try {
				const seen = []
				const fsp = require('node:fs/promises')
				const probe = await fsp.open(path.join(OUT, 'driver-log.txt'), 'r')
				const proto = Object.getPrototypeOf(probe)
				await probe.close()
				const origWrite = proto.writeFile
				proto.writeFile = async function (...a) { try { return await origWrite.apply(this, a) } catch (e) { seen.push('writeFile: ' + e.code + ' ' + e.message); throw e } }
				const mod = await import(require('node:url').pathToFileURL(path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dist', 'main', 'local-speech-install.js')).href)
				const loggingFetch = async (url, init) => {
					const t = Date.now()
					try {
						const r = await fetch(url, init)
						seen.push(`fetch ${String(url).split('/').pop()} ${r.status} ${new URL(r.url).host} ${Date.now() - t}ms`)
						const orig = r.body && r.body.getReader.bind(r.body)
						if (orig) Object.defineProperty(r.body, 'getReader', { value: () => { const rd = orig(); const read = rd.read.bind(rd); rd.read = async () => { try { return await read() } catch (e) { seen.push('read: ' + String(e) + ' cause=' + String(e.cause && (e.cause.code || e.cause.message))); throw e } }; return rd } })
						return r
					} catch (e) { seen.push('fetch threw: ' + String(e) + ' cause=' + String(e.cause && (e.cause.code || e.cause.message))); throw e }
				}
				const dir = 'C:\\work\\speech-replica'
				fs.rmSync(dir, { recursive: true, force: true })
				const t2 = Date.now()
				let result
				try { const inst = await mod.installLocalSpeech({ directory: dir, fetch: loggingFetch, python: { program: py, args: [] } }); result = { ok: true, keys: Object.keys(inst) } } catch (e) { result = { ok: false, error: String(e).slice(0, 300) } }
				out.moduleReplica = { ms: Date.now() - t2, result, seen }
			} catch (e) { out.moduleReplica = { error: String((e && e.stack) || e).slice(0, 800) } }
			// 1) Does the venv's torch import on this clean machine? Install the downloaded wheels and import.
			try {
				const venvPy = 'C:\\work\\replica\\venv\\Scripts\\python.exe'
				const run2 = (args, ms) => { const t = Date.now(); try { const o = execFileSync(venvPy, args, { encoding: 'utf8', timeout: ms, stdio: ['ignore', 'pipe', 'pipe'] }); return { ok: true, ms: Date.now() - t, tail: o.slice(-300) } } catch (e) { return { ok: false, ms: Date.now() - t, tail: String((e.stderr || '') + (e.stdout || '') || e).slice(-1200) } } }
				out.torchImport = {
					install: run2(['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', 'install', '--no-index', '--find-links', 'C:\\work\\replica\\w', 'torch==2.14.1+cpu'], 600000),
					import: run2(['-I', '-c', 'import torch; print(torch.__version__)'], 300000),
					vcRuntimeDll: fs.existsSync('C:\\Windows\\System32\\vcruntime140.dll'),
					vcRuntime1Dll: fs.existsSync('C:\\Windows\\System32\\vcruntime140_1.dll'),
					msvcp140Dll: fs.existsSync('C:\\Windows\\System32\\msvcp140.dll'),
				}
				// Candidate fixes, in order: the msvc-runtime wheel alone, then its DLLs copied beside torch's own.
				out.torchImport.msvcRuntimeWheel = run2(['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', 'install', 'msvc-runtime==14.44.35112'], 300000)
				out.torchImport.importAfterWheel = run2(['-I', '-c', 'import torch; print(torch.__version__)'], 300000)
				out.torchImport.wheelFiles = ['C:\\work\\replica\\venv', 'C:\\work\\replica\\venv\\Scripts'].map((d) => ({ dir: d, dlls: fs.readdirSync(d).filter((f) => /^(msvcp|vcruntime|vcomp|concrt)/i.test(f)) }))
				if (!out.torchImport.importAfterWheel.ok) {
					const lib = 'C:\\work\\replica\\venv\\Lib\\site-packages\\torch\\lib'
					for (const f of fs.readdirSync('C:\\work\\replica\\venv\\Scripts').filter((f) => /^(msvcp|vcruntime|vcomp|concrt)/i.test(f) && f.endsWith('.dll'))) fs.copyFileSync(path.join('C:\\work\\replica\\venv\\Scripts', f), path.join(lib, f))
					out.torchImport.importAfterCopyToTorchLib = run2(['-I', '-c', 'import torch; print(torch.__version__)'], 300000)
				}
			} catch (e) { out.torchImport = { error: String(e).slice(0, 400) } }
			// 2) The same model download from a real Electron main process.
			try {
				const t = Date.now()
				// An app.asar next to the executable wins over the path argument, so run a copy that has none.
				try { execFileSync('robocopy', [path.dirname(process.execPath), 'C:\\drv2', '/E', '/XF', 'app.asar', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'ignore' }) } catch {} // robocopy exits non-zero on success
				const child = spawn('C:\\drv2\\drv-node.exe', ['C:\\in\\probe-main'], { env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')), stdio: ['ignore', fs.openSync('C:\\out\\probe-main.err', 'w'), fs.openSync('C:\\out\\probe-main.err', 'a')] })
				await new Promise((r) => { child.once('exit', r); setTimeout(r, 240000) })
				out.mainProcessFetch = fs.existsSync('C:\\out\\probe-main.json') ? JSON.parse(fs.readFileSync('C:\\out\\probe-main.json', 'utf8')) : { missing: true, ms: Date.now() - t }
			} catch (e) { out.mainProcessFetch = { error: String(e).slice(0, 300) } }
			return { result: 'fail', stage: 'install', ...out }
		}
		await cdp.evaluate('window.namzu.localSpeechConfigure({enabled:true})')
		await cdp.evaluate(`window.__sp={frames:[],end:null,error:null}; window.namzu.onLocalSpeechEvent(e=>{ if(e.type==='audio'){window.__sp.frames.push({seq:e.sequence,rate:e.sampleRate,fmt:e.format,ch:e.channels,b64:e.pcmBase64}); window.namzu.localSpeechAcknowledge(e.requestId,e.sequence)} else if(e.type==='end') window.__sp.end=e.reason; else if(e.type==='error') window.__sp.error=e.message }); 1`)
		const ts = Date.now()
		await cdp.evaluate(`window.namzu.localSpeechSpeak({requestId:'sandbox-1',text:'Merhaba! Ben Namzu. Türkçe seslendirme bu cihazda çalışıyor.',language:'tr'})`)
		let firstMs = null
		for (let i = 0; i < 180; i++) {
			await sleep(500)
			const s = JSON.parse(await cdp.evaluate('JSON.stringify({n:window.__sp.frames.length,end:window.__sp.end,error:window.__sp.error})'))
			if (s.n && firstMs === null) firstMs = Date.now() - ts
			if (s.end || s.error) break
		}
		const frames = JSON.parse(await cdp.evaluate('JSON.stringify(window.__sp.frames)'))
		const sp = JSON.parse(await cdp.evaluate('JSON.stringify({end:window.__sp.end,error:window.__sp.error})'))
		const bufs = frames.map((f) => Buffer.from(f.b64, 'base64'))
		const pcm = Buffer.concat(bufs)
		const samples = pcm.length / 2
		let sum = 0
		for (let i = 0; i + 1 < pcm.length; i += 2) { const v = pcm.readInt16LE(i); sum += v * v }
		const rms = samples ? Math.sqrt(sum / samples) : 0
		const contiguous = frames.every((f, i) => f.seq === frames[0].seq + i)
		out.speak = { firstAudioMs: firstMs, totalMs: Date.now() - ts, frames: frames.length, bytes: pcm.length, sampleRate: frames[0] && frames[0].rate, format: frames[0] && frames[0].fmt, channels: frames[0] && frames[0].ch, maxFrameBytes: Math.max(0, ...bufs.map((b) => b.length)), contiguous, durationSeconds: samples / 24000, rms: Math.round(rms), sha256: crypto.createHash('sha256').update(pcm).digest('hex'), end: sp.end, error: sp.error }
		out.audioContext = JSON.parse(await cdp.evaluate(`(async()=>{ const c=new AudioContext({sampleRate:24000}); const info={state:c.state,sampleRate:c.sampleRate,baseLatency:c.baseLatency}; try{ await c.resume(); info.afterResume=c.state; const b=c.createBuffer(1,2400,24000); const s=c.createBufferSource(); s.buffer=b; s.connect(c.destination); const ended=new Promise(r=>{s.onended=()=>r(true)}); s.start(); info.ended=await Promise.race([ended,new Promise(r=>setTimeout(()=>r(false),5000))]) }catch(e){info.error=String(e)} return JSON.stringify(info) })()`))
		const ok = sp.end === 'completed' && !sp.error && frames[0] && frames[0].rate === 24000 && frames[0].fmt === 'pcm_s16le' && frames[0].ch === 1 && contiguous && rms > 50 && out.speak.maxFrameBytes <= 9600 && out.speak.durationSeconds > 1
		await cdp.shot('05-speech.png')
		const state = JSON.parse(await cdp.evaluate('window.namzu.localSpeechState().then(s=>JSON.stringify(s))'))
		out.resources = state.resources
		return { result: ok ? 'pass' : 'fail', ...out }
	})
	try { fs.cpSync(path.join(userData, 'logs'), path.join(OUT, 'userdata-logs-A'), { recursive: true }) } catch {}

	const draftMarker = 'sandbox-marker-' + crypto.randomBytes(4).toString('hex')
	if (session) await cdp.evaluate(`window.namzu.saveDraft(${JSON.stringify(session)}, ${JSON.stringify(draftMarker)})`).catch(() => {})
	fs.writeFileSync(path.join(userData, 'sandbox-marker.txt'), draftMarker)
	await sleep(2500)
	await stopApp(cdp, child)
	log('app A stopped')

	// ---------- run B: update feed served from inside the sandbox ----------
	const feed = http.createServer((req, res) => {
		const file = path.join('C:\\in\\feed', decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, ''))
		log('feed', req.method, req.url, req.headers.range || '')
		fs.stat(file, (err, st) => {
			if (err || !st.isFile()) { res.writeHead(404); return res.end() }
			res.writeHead(200, { 'content-length': st.size, 'content-type': 'application/octet-stream' })
			fs.createReadStream(file).pipe(res)
		})
	}).listen(FEED_PORT, '127.0.0.1')
	const versionBefore = exeVersion()
	const childB = launch({ NAMZU_UPDATE_FEED_URL: `http://127.0.0.1:${FEED_PORT}/`, ELECTRON_EXTRA_LAUNCH_ARGS: `--remote-debugging-port=${PORT}` }, 'B')
	let cdpB
	let updateReady = false
	await step('06-update-find-download.json', 'updater finds and downloads v2', async () => {
		cdpB = await connect()
		await sleep(3000)
		const seen = []
		let st
		for (let i = 0; i < 240; i++) {
			st = JSON.parse(await cdpB.evaluate('window.namzu.updateState().then(s=>JSON.stringify(s))'))
			if (!seen.length || seen[seen.length - 1] !== st.status) seen.push(st.status)
			if (st.status === 'ready' || st.status === 'error') break
			if (i === 40 && st.status === 'idle') await cdpB.evaluate('window.namzu.checkForUpdate().then(()=>1)') // do not wait for the 30 s timer twice
			await sleep(1000)
		}
		updateReady = st.status === 'ready'
		await sleep(1000)
		await cdpB.shot('06-badge.png')
		const badge = await cdpB.evaluate(`(()=>{ const b=document.querySelector('[aria-label^="Update ready"]'); return b? b.getAttribute('aria-label') : null })()`)
		return { result: updateReady && st.version === '0.1.1' ? 'pass' : 'fail', installedBefore: versionBefore, finalState: st, seen, badgeLabel: badge }
	})

	await step('07-update-install-restart.json', 'v1 installs v2 through the dialog and restarts', async () => {
		if (!updateReady) return { result: 'blocked', reason: 'no update was downloaded' }
		// A person typed a draft just before this point; make the gate see an idle app, then go through the real badge and dialog.
		const clickBadge = await cdpB.evaluate(`(()=>{ const b=document.querySelector('[aria-label^="Update ready"]'); if(!b) return false; b.click(); return true })()`)
		await sleep(1200)
		await cdpB.shot('07-dialog.png')
		const dialog = await cdpB.evaluate(`(()=>{ const d=document.querySelector('[role="dialog"]'); return d? d.innerText.slice(0,300):null })()`)
		const clicked = await cdpB.evaluate(`(()=>{ const b=[...document.querySelectorAll('[role="dialog"] button')].find(x=>/restart now/i.test(x.innerText)); if(!b) return false; setTimeout(()=>b.click(),50); return true })()`).catch((e) => 'lost: ' + e)
		await sleep(350)
		try { await cdpB.shot('07-installing.png') } catch (e) { log('no installing shot', String(e)) }
		const tRestart = Date.now()
		const pidsBefore = namzuPids()
		// Wait for the app to go away and the new one to come back, polling the real machine.
		let sawGone = false, back = false, versionAfter
		for (let i = 0; i < 360; i++) {
			await sleep(1000)
			const pids = namzuPids()
			if (!pids) sawGone = true
			if (sawGone && pids) { back = true; break }
		}
		const msToBack = Date.now() - tRestart
		versionAfter = exeVersion()
		await sleep(8000)
		screen('07-after-restart-screen.png') // the app the installer started itself, no debug port
		const relaunchedPids = namzuPids()
		const relaunchedCommand = execFileSync('powershell.exe', ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter \"Name='Namzu.exe'\" | Select-Object -First 1 -ExpandProperty CommandLine)"], { encoding: 'utf8' }).trim()
		// Its debug port is not ours to choose: stop it and start the installed v2 with the port, over the same profile.
		killApp()
		await sleep(2000)
		const childC = launch({}, 'C')
		let cdpC = null, reconnect = null
		try { cdpC = await connect(60_000) } catch (e) { reconnect = String(e).slice(0, 200) }
		const out = { clickBadge, dialog, clicked, pidsBefore, sawGone, relaunched: back, msToBack, installedAfter: versionAfter, relaunchedPids, relaunchedCommandLength: relaunchedCommand.length, cdpAfterRestart: !!cdpC, reconnect }
		if (cdpC) {
			await sleep(6000)
			out.page = JSON.parse(await cdpC.evaluate('JSON.stringify({title:document.title,api:typeof window.namzu})'))
			out.draft = session ? await cdpC.evaluate(`window.namzu.draft(${JSON.stringify(session)})`).catch((e) => 'ERR ' + e) : null
			out.draftSurvived = out.draft === draftMarker
			out.projects = JSON.parse(await cdpC.evaluate('window.namzu.projects().then(p=>JSON.stringify(p.map(x=>({path:x.path,status:x.status,trusted:x.trusted}))))'))
			out.updateState = JSON.parse(await cdpC.evaluate('window.namzu.updateState().then(s=>JSON.stringify(s))'))
			await cdpC.shot('07-after-restart.png')
			await stopApp(cdpC, childC)
		}
		out.markerFileSurvived = fs.existsSync(path.join(userData, 'sandbox-marker.txt')) && fs.readFileSync(path.join(userData, 'sandbox-marker.txt'), 'utf8') === draftMarker
		out.speechInstallSurvived = fs.existsSync(path.join(userData, 'local-speech'))
		const ok = clicked !== false && sawGone && back && versionAfter.startsWith('0.1.1') && out.markerFileSurvived
		out.result = ok ? (cdpC ? (out.draftSurvived ? 'pass' : 'fail') : 'pass') : 'fail'
		if (ok && !cdpC) out.note = 'The relaunched app had no debug port, so the draft could not be read over CDP; the marker file in userData survived.'
		return out
	})
	feed.close()
	killApp()

	// The uninstall check runs from run.ps1: the uninstaller stops every Namzu.exe, this driver included.
	log('all done after', Math.round((Date.now() - t0) / 1000), 's')
})().catch((e) => { log('driver crashed', e); receipt('99-driver-crash.json', { error: String((e && e.stack) || e) }) })
