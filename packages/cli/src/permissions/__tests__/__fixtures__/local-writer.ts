/**
 * One writer of a folder's local settings, run as its own process: it moves
 * the earlier file, then saves `count` answers of its own, each waiting for the
 * lock as long as it takes. Prints what the move did and any write that failed.
 *
 * Usage: node --import tsx local-writer.ts <folder> <name> <count>
 */

import { moveLegacyLocalConfig, writeLocalAllows } from '../../local-settings.js'

const [cwd, name, count] = process.argv.slice(2)
if (cwd === undefined || name === undefined || count === undefined) {
	process.stderr.write('usage: local-writer.ts <folder> <name> <count>\n')
	process.exit(2)
}
const wait = { lockWaitMs: 600_000 }
const move = moveLegacyLocalConfig(cwd, wait)
const errors: string[] = []
for (let n = 0; n < Number(count); n += 1) {
	const write = writeLocalAllows(cwd, { bash: { [`echo ${name}${n} *`]: 'allow' } }, wait)
	const problem = write.error ?? write.sentence
	if (problem !== undefined) errors.push(problem)
}
process.stdout.write(JSON.stringify({ move, errors }))
process.exitCode = errors.length > 0 ? 1 : 0
