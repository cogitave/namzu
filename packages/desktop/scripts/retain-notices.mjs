import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = new URL('../', import.meta.url)
// TypeScript checks the development-only fixture, but it must not ship beside
// the native application. Vite's production entry never imports it either.
for (const suffix of ['js', 'js.map', 'd.ts', 'd.ts.map']) {
	rmSync(new URL(`dist/dev/preview.${suffix}`, root), { force: true })
}
mkdirSync(new URL('dist/licenses/', root), { recursive: true })
for (const path of ['THIRD-PARTY-NOTICES.txt', 'licenses/ui-primitives-MIT.txt', 'licenses/ui-layout-Apache-2.0.txt', 'licenses/ui-layout-NOTICE.txt', 'licenses/ui-icons-license.txt', 'licenses/pal-character-three-MIT.txt', 'licenses/pal-novnc-LICENSE.txt', 'licenses/pal-novnc-MPL-2.0.txt', 'licenses/pal-novnc-pako-MIT.txt', 'licenses/pal-ws-MIT.txt', 'licenses/pal-novnc-LICENSE.BSD-2-Clause.txt', 'licenses/pal-novnc-LICENSE.BSD-3-Clause.txt', 'licenses/pal-novnc-AUTHORS.txt', 'licenses/pal-novnc-des-notice.txt', 'licenses/files-ignore-MIT.txt', 'licenses/files-yaml-ISC.txt', 'licenses/files-headless-tree-MIT.txt', 'licenses/files-tanstack-react-virtual-MIT.txt', 'licenses/files-fuzzysort-MIT.txt', 'licenses/files-remark-frontmatter-MIT.txt']) {
	copyFileSync(fileURLToPath(new URL(path, root)), fileURLToPath(new URL(`dist/${path}`, root)))
}
