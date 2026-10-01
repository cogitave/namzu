import { copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = new URL('../', import.meta.url)
mkdirSync(new URL('dist/licenses/', root), { recursive: true })
for (const path of ['THIRD-PARTY-NOTICES.txt', 'licenses/ui-primitives-MIT.txt', 'licenses/ui-layout-Apache-2.0.txt', 'licenses/ui-layout-NOTICE.txt', 'licenses/ui-icons-license.txt']) {
	copyFileSync(fileURLToPath(new URL(path, root)), fileURLToPath(new URL(`dist/${path}`, root)))
}
