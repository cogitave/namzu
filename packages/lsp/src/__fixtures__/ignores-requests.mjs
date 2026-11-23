/**
 * A server that completes the handshake and then answers nothing.
 *
 * The state a real server is in while it is still indexing, or wedged on a
 * workspace it cannot finish: `initialize` worked, so the startup timeout is
 * not the one holding the call, and every navigation request would wait out
 * the request timeout. It records each request it receives (and each
 * `$/cancelRequest`) to a marker file, so a test can abort a request only
 * after the server has it — never before it was sent, which would prove
 * nothing about an in-flight request.
 */

import { appendFileSync } from 'node:fs'

import { serve } from './lsp-frames.mjs'

const marker = process.argv[2]

serve((message, send) => {
	if (message.method === 'initialize' && message.id !== undefined) {
		send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } })
		return
	}
	if (marker && typeof message.method === 'string') appendFileSync(marker, `${message.method}\n`)
})