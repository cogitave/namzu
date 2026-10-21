// Indexes a root and does NOT dispose the provider: the process must still exit on its own.
import { createCodeAnalysisProvider } from '../../dist/index.js'

const [, , root] = process.argv
const p = createCodeAnalysisProvider({})
const r = await p.index({ root })
console.log(JSON.stringify({ kind: r.kind, indexed: r.kind === 'ok' ? r.value.files.indexed : 0 }))
