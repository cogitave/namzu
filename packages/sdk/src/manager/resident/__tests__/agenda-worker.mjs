import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DiskResidentAgenda, ResidentHost } from '../../../../dist/index.js'

const [root, tenantId, pursuitId, mode] = process.argv.slice(2)
const agenda = new DiskResidentAgenda(root, { tenantId, agentKey: 'agenda-process-check' })
const execution = agenda.execution(pursuitId)
const snapshot = await execution.read()
if (!snapshot) throw new Error('Worker pursuit is missing.')
process.once('message', async (message) => {
	if (message !== 'go') throw new Error('Unexpected agenda worker message.')
	try {
		if (mode === 'effect') {
			const host = new ResidentHost(agenda, async () => {
				await writeFile(join(root, 'effect.txt'), 'applied once', { flag: 'wx' })
				process.send('effect-applied')
				await new Promise(() => {}) // Parent kills the process before settlement.
			})
			await host.run({ signal: new AbortController().signal, maxSteps: 1 })
			return
		}
		await execution.claim(snapshot, Date.now())
		process.send('claimed', () => process.exit(0))
	} catch (error) {
		process.send(error.name, () => process.exit(0))
	}
})
process.send({ ready: pursuitId, phase: snapshot.phase })
