import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [dist, mode, baseDir, worker] = process.argv.slice(2)
const { DiskMemoryStore } = await import(pathToFileURL(join(dist, 'index.js')).href)
const receive = () => new Promise((resolve) => process.once('message', resolve))
const logger = {
	debug() {}, warn() {}, error() {}, child() { return this },
	info(message) {
		if (mode !== 'hold' || message !== 'Memory index loaded') return
		writeFileSync(join(baseDir, 'owner-ready'), 'ready')
		// Hold an actual store transaction after acquiring its lock, so the
		// parent can kill this process and verify fail-closed cold admission.
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
	},
}
const store = new DiskMemoryStore({ baseDir, logger })
if (mode === 'hold') {
	await store.create({ title: 'never completes', summary: '', content: '' })
} else {
	await store.list()
	const next = receive()
	process.send({ type: 'ready' })
	await next
	if (mode === 'writer') {
		const ids = []
		for (let index = 0; index < 12; index++) {
			const saved = await store.create({
				title: `Worker ${worker} note ${index}`,
				summary: 'Durable note',
				content: `body-only-marker ${worker} ${index}`,
			})
			ids.push(saved.entry.id)
		}
		process.send({ type: 'done', ids })
	} else {
		const found = await store.list({ query: 'body-only-marker', limit: 100 })
		const bodies = []
		for (const entry of found.entries) bodies.push((await store.get(entry.id)).content)
		process.send({ type: 'done', ids: found.entries.map((entry) => entry.id), bodies })
	}
	process.disconnect()
}
