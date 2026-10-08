// Runs under the installed app's Electron as a real main process (not Node mode) to see how its global
// fetch behaves on the model download the speech installer performs. Writes C:\out\probe-main.json.
const { app } = require('electron')
const fs = require('node:fs')
app.whenReady().then(async () => {
	const out = { electron: process.versions.electron, node: process.versions.node, fetchIsNative: String(fetch).includes('[native code]') || undefined, runs: [] }
	const base = 'https://huggingface.co/canberkkkkkk/ema-lightning/resolve/7a6ba1ad216bb2f1da9863f80ac8770a6a807632/'
	for (const name of ['ema.pt', 'decoder.pt', 'ema.pt', 'decoder.pt']) {
		const t = Date.now()
		const run = { name }
		try {
			const r = await fetch(base + name)
			run.status = r.status
			run.host = new URL(r.url).host
			let n = 0
			const reader = r.body.getReader()
			for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.byteLength }
			run.bytes = n
		} catch (e) { run.error = String(e); run.cause = String(e && e.cause && (e.cause.code || e.cause.message)) }
		run.ms = Date.now() - t
		out.runs.push(run)
	}
	fs.writeFileSync('C:\\out\\probe-main.json', JSON.stringify(out, null, 2))
	app.exit(0)
})
