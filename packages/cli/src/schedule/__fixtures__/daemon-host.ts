/**
 * A daemon in its own process, spawning `slow-fire.mjs` as its fire child
 * through the real `spawnFireProcess`. argv: <home> <slow-fire path>
 */
import { NOOP_LOGGER } from '@namzu/sdk'
import { ScheduleDaemon, spawnFireProcess } from '../daemon/daemon.js'
import { schedulePaths } from '../paths.js'

const [home = '', fire = ''] = process.argv.slice(2)
const paths = schedulePaths(home)
const daemon = new ScheduleDaemon({
	paths,
	log: NOOP_LOGGER,
	version: 'fixture',
	epoch: `fixture-${process.pid}`,
	maxConcurrentRuns: 2,
	notifications: false,
	spawnFire: spawnFireProcess({ node: process.execPath, bin: fire, paths, env: process.env }),
	notify: async () => {},
	fingerprint: () => 'same',
	tickMs: 50,
	standbyPollMs: 50,
})
process.on('SIGTERM', () => daemon.stop())
void daemon.run().then((code) => process.exit(code))
