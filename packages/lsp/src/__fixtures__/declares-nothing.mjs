/**
 * A server that initializes and declares no navigation capability at all.
 *
 * The provider must say `unsupported` naming what is missing rather than
 * sending a request and reporting whatever error comes back — a caller
 * needs to know it should fall back, and "method not found" arriving from a
 * server that never claimed the method is a worse way to learn it.
 */

import { serve } from './lsp-frames.mjs'

serve((message, send) => {
	if (message.id === undefined) return
	send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } })
})
