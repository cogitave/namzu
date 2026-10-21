// Run by concurrency.test.ts in several processes at once: index one root into one cache.
import { createCodeAnalysisProvider } from '../../dist/index.js'

const [, , root, cacheDir, needle] = process.argv
const p = createCodeAnalysisProvider({ cacheDir })
const r = await p.index({ root })
if (r.kind !== 'ok') {
	console.log(JSON.stringify({ pid: process.pid, kind: r.kind, error: r.error ?? r.reason }))
	process.exit(1)
}
const t = await p.findLiteral({ root, text: needle })
console.log(JSON.stringify({ pid: process.pid, indexed: r.value.files.indexed, hits: t.kind === 'ok' ? t.value.total : (t.error ?? t.reason) }))
await p.dispose()
