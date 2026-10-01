import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = new URL('../', import.meta.url)
// TypeScript checks the development-only fixture, but it must not ship beside
// the native application. Vite's production entry never imports it either.
for (const suffix of ['js', 'js.map', 'd.ts', 'd.ts.map']) {
	rmSync(new URL(`dist/dev/preview.${suffix}`, root), { force: true })
}
mkdirSync(new URL('dist/licenses/', root), { recursive: true })
for (const path of ['THIRD-PARTY-NOTICES.txt', 'licenses/ui-primitives-MIT.txt', 'licenses/ui-layout-Apache-2.0.txt', 'licenses/ui-layout-NOTICE.txt', 'licenses/ui-icons-license.txt']) {
	copyFileSync(fileURLToPath(new URL(path, root)), fileURLToPath(new URL(`dist/${path}`, root)))
}
