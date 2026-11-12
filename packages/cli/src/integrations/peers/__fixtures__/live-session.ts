/**
 * A session process for the process-level test: a real live inbox (`openLivePeers`) on the conversation
 * named in argv, in its own process. It says what happens on standard output, one line each, and does
 * what it is told on standard input:
 *   take  - takes what is in the inbox, as a request boundary would, and says what it took
 *   quit  - closes the inbox and exits
 */
import { createInterface } from 'node:readline'
import { openLivePeers } from '../runtime.js'

const [, , home, cwd, conversation] = process.argv as [string, string, string, string, string]
let accepted = 0
const say = (line: string): void => void process.stdout.write(`${line}\n`)

const peers = await openLivePeers({
	home,
	cwd,
	version: 'fixture',
	mode: () => 'auto',
	owner: () => 0,
	state: () => 'idle',
	ready: () => true,
	available: () => say(`accepted:${++accepted}`),
	report: () => {},
	conversation: () => conversation,
})
say('ready')
for await (const line of createInterface({ input: process.stdin })) {
	if (line === 'take') {
		for (const mail of peers.take(0))
			say(`took ${JSON.stringify({ kind: mail.from.kind, text: mail.text })}`)
		say('taken')
	} else if (line === 'quit') {
		await peers.close()
		say('closed')
		break
	}
}
process.exit(0)
