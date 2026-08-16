/**
 * A server that initializes and then says it cannot do anything else.
 *
 * `-32601` is how a real server declines a capability it does not have, and
 * the provider has to read it as `unsupported` rather than `failed`: a
 * caller can fall back to grep and SAY the answer is textual, where a
 * failure means the answer is unknown and a fallback would be a guess.
 */

import { serve } from './lsp-frames.mjs'

serve((message, send) => {
	if (message.id === undefined) return
	send(
		message.method === 'initialize'
			? { jsonrpc: '2.0', id: message.id, result: { capabilities: {} } }
			: { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } },
	)
})
