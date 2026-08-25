import { appendFileSync } from 'node:fs'

import { send, serve } from './lsp-frames.mjs'

const marker = process.argv[2]
appendFileSync(marker, `pid:${process.pid}\n`)

// Keep the process alive after stdout closes. A transport owner must not
// confuse a live PID with a usable response channel, and must still retain
// that PID for teardown.
setInterval(() => {}, 1_000)
setTimeout(() => process.exit(2), 5_000)

serve((message) => {
	if (message.method === 'initialize') {
		send({
			jsonrpc: '2.0',
			id: message.id,
			result: {
				capabilities: {
					definitionProvider: true,
					referencesProvider: true,
				},
			},
		})
		return
	}
	if (message.method === 'textDocument/references') {
		appendFileSync(marker, 'references\n')
		process.stdout.end()
		return
	}
	if (message.method === 'exit') process.exit(0)
})
