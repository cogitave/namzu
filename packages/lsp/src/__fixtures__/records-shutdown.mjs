/**
 * A server that writes down what it was asked before it exits.
 *
 * The disposal test that observes the PROCESS passes whether or not the
 * handshake was sent, because `dispose` kills as a fallback and the process
 * dies either way. This stub is how the handshake itself is asserted: some
 * servers hold a lock file or are mid-write on an index, and for those the
 * difference between "asked to stop" and "killed" is real.
 */

import { appendFileSync } from 'node:fs'

import { serve } from './lsp-frames.mjs'

const marker = process.argv[2]

serve((message, send) => {
	if (message.method === 'shutdown') appendFileSync(marker, 'shutdown\n')
	if (message.method === 'exit') {
		appendFileSync(marker, 'exit\n')
		process.exit(0)
	}
	if (message.id !== undefined) {
		send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } })
	}
})
