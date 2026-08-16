/**
 * A server with document symbols and no workspace index.
 *
 * The fallback this exists to drive is chosen from the DECLARED capability,
 * not by sending `workspace/symbol` and swallowing whatever comes back — a
 * server can answer an error for a transient reason, and a fallback that
 * fired on any error would take the document path for a capability the
 * server has.
 */

import { serve } from './lsp-frames.mjs'

serve((message, send) => {
	if (message.id === undefined) return
	if (message.method === 'initialize') {
		send({
			jsonrpc: '2.0',
			id: message.id,
			result: { capabilities: { documentSymbolProvider: true, hoverProvider: true } },
		})
		return
	}
	if (message.method === 'textDocument/documentSymbol') {
		send({
			jsonrpc: '2.0',
			id: message.id,
			result: [
				{
					name: 'computeTotal',
					kind: 12,
					range: { start: { line: 7, character: 16 }, end: { line: 11, character: 1 } },
					selectionRange: { start: { line: 7, character: 16 }, end: { line: 7, character: 28 } },
					children: [
						{
							name: 'label',
							kind: 13,
							range: { start: { line: 8, character: 7 }, end: { line: 8, character: 12 } },
							selectionRange: { start: { line: 8, character: 7 }, end: { line: 8, character: 12 } },
						},
					],
				},
			],
		})
		return
	}
	send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
})
