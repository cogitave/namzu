// usage: node setup-home.mjs <repo root> <scratch home> <proxy port> <model>
// Writes an account that points at the recording proxy, with a dummy key (the real key never appears here),
// the model preference, and a browser config that runs headless with every site at `act`.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [root, home, port, model] = process.argv.slice(2)
const { createAccountRegistry } = await import(pathToFileURL(join(root, 'packages/sdk/dist/index.js')).href)
const nh = join(home, '.namzu')
mkdirSync(nh, { recursive: true })
const reg = createAccountRegistry({ home: nh })
try {
	reg.add({ provider: 'openrouter', label: 'proxy', kind: 'api-key', apiKey: 'sk-or-local-proxy', baseUrl: `http://127.0.0.1:${port}/api/v1`, defaultModel: model })
} catch {}
writeFileSync(join(nh, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'openrouter', model, account: 'openrouter:proxy' }] }, null, 2))
writeFileSync(join(nh, 'config.yaml'), `browser:\n  engine: local\n  headless: ${process.env.CU_HEADLESS ?? 'always'}\n  sites:\n    "*": act\n`)
