/**
 * One answer saved to a folder's local settings, run as its own process so the
 * caller can start it under a file-size limit. Prints what the write said.
 *
 * Usage: node --import tsx local-short-disk.ts <folder>
 */

import { writeLocalAllows } from '../../local-settings.js'

const [cwd] = process.argv.slice(2)
if (cwd === undefined) {
	process.stderr.write('usage: local-short-disk.ts <folder>\n')
	process.exit(2)
}
const write = writeLocalAllows(cwd, { bash: { 'echo one-more *': 'allow' } })
process.stdout.write(JSON.stringify(write))
