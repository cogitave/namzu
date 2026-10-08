// Writes a generic electron-updater feed (latest.yml) next to an installer.
//   node make-feed.mjs <installer.exe> <version> <out-dir>
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
const [installer, version, out] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const name = basename(installer)
copyFileSync(installer, join(out, name))
copyFileSync(`${installer}.blockmap`, join(out, `${name}.blockmap`))
const sha512 = createHash('sha512').update(readFileSync(installer)).digest('base64')
const size = statSync(installer).size
writeFileSync(
	join(out, 'latest.yml'),
	`version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${size}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`,
)
console.log(JSON.stringify({ name, version, size }))
