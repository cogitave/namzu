// Bundle existing installed dependencies only. Does not install packages.
// Usage: node prepare-native-schedule-proof.mjs <Windows-backed output.mjs>
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const repo = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(resolve(repo, 'packages/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const outfile = process.argv[2]
if (!outfile) throw new Error('Expected a Windows-backed output path')
await build({
  entryPoints: [fileURLToPath(new URL('./native-schedule-proof.mjs', import.meta.url))],
  outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: 'import { createRequire as __nativeCreateRequire } from "node:module"; const require = __nativeCreateRequire(import.meta.url);' },
})
