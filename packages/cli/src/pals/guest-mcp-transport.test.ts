import type { MCPJsonRpcMessage } from '@namzu/sdk'
import { expect, it, vi } from 'vitest'
import { guestMcpChannel } from './__fixtures__/guest-mcp-channel.js'
import { PalGuestMcpTransport } from './guest-mcp-transport.js'

const request = {
	jsonrpc: '2.0' as const,
	id: 1,
	method: 'tools/call',
	params: { name: 'execute' },
}
function received(transport: PalGuestMcpTransport): Promise<MCPJsonRpcMessage> {
	return new Promise((resolve) => transport.onMessage(resolve))
}

it('refuses oversized UTF-8 requests and notifications before admission, then accepts later work', async () => {
	const f = guestMcpChannel()
	const transport = new PalGuestMcpTransport(async () => f.channel)
	await transport.connect()
	const params = { code: 'é'.repeat(512 * 1024) }
	// Counting JS characters would pass this message; the guest bound is in bytes.
	const oversized = { ...request, params }
	await expect(transport.send(oversized)).rejects.toThrow(
		'This guest MCP request exceeds the 1 MiB write limit; nothing was sent.',
	)
	await expect(
		transport.send({ jsonrpc: '2.0', method: 'notifications/progress', params }),
	).rejects.toThrow('nothing was sent')
	expect(f.channel.beginOperation).not.toHaveBeenCalled()
	expect(f.channel.write).not.toHaveBeenCalled()
	expect(f.operations).toHaveLength(0)
	expect(transport.isConnected()).toBe(true)
	await transport.send(request)
	const next = received(transport)
	f.reply({
		jsonrpc: '2.0',
		id: 1,
		result: { _meta: { 'namzu/outcome': 'settled' }, content: [] },
	})
	await next
	expect(f.operations[0]?.complete).toHaveBeenCalledOnce()
	expect(f.operations[0]?.outcomeUnknown).not.toHaveBeenCalled()
	await transport.close()
})

it('holds authority after delivery, accepts exact reply and preserves binary image content', async () => {
	const f = guestMcpChannel()
	const transport = new PalGuestMcpTransport(async () => f.channel)
	await transport.connect()
	await transport.send(request)
	expect(f.operations[0]?.complete).not.toHaveBeenCalled()
	let next = received(transport)
	f.reply({ jsonrpc: '2.0', id: 99, result: {} })
	await next
	expect(f.operations[0]?.complete).not.toHaveBeenCalled()
	next = received(transport)
	const result = {
		_meta: { 'namzu/outcome': 'settled' },
		content: [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }],
	}
	const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n`)
	f.pushBytes(bytes.subarray(0, 13))
	f.pushBytes(bytes.subarray(13))
	expect((await next).result).toEqual(result)
	expect(f.operations[0]?.complete).toHaveBeenCalledOnce()
	expect(f.operations[0]?.outcomeUnknown).not.toHaveBeenCalled()
	await transport.close()
})

it.each(['missing', 'unknown', 'rpc-error'])(
	'fences a %s application outcome and never declares successful text certain',
	async (kind) => {
		const f = guestMcpChannel()
		const transport = new PalGuestMcpTransport(async () => f.channel)
		await transport.connect()
		await transport.send(request)
		const next = received(transport)
		f.reply(
			kind === 'rpc-error'
				? {
						jsonrpc: '2.0',
						id: 1,
						error: { code: -32000, message: 'Editor connection lost' },
					}
				: {
						jsonrpc: '2.0',
						id: 1,
						result: {
							content: [
								{
									type: 'text',
									text: 'Error executing code: No data received',
								},
							],
							...(kind === 'unknown' ? { _meta: { 'namzu/outcome': 'unknown' } } : {}),
						},
					},
		)
		const result = await next
		expect(f.operations[0]?.outcomeUnknown).toHaveBeenCalledOnce()
		expect(f.operations[0]?.complete).not.toHaveBeenCalled()
		if (kind !== 'rpc-error')
			expect(result.result).toMatchObject({
				isError: true,
				_meta: { 'namzu/outcome': 'unknown' },
			})
		await transport.close()
	},
)

it('cancellation retains uncertainty after a late positive reply; preabort dispatches nothing', async () => {
	const f = guestMcpChannel()
	const transport = new PalGuestMcpTransport(async () => f.channel)
	await transport.connect()
	const pre = new AbortController()
	pre.abort(new Error('Before admission'))
	await expect(transport.send(request, { signal: pre.signal })).rejects.toThrow('Before admission')
	expect(f.operations).toHaveLength(0)
	const controller = new AbortController()
	await transport.send(request, { signal: controller.signal })
	controller.abort(new Error('Stopped after delivery'))
	expect(f.operations[0]?.outcomeUnknown).toHaveBeenCalledOnce()
	const next = received(transport)
	f.reply({
		jsonrpc: '2.0',
		id: 1,
		result: { _meta: { 'namzu/outcome': 'settled' }, content: [] },
	})
	await next
	expect(f.operations[0]?.complete).not.toHaveBeenCalled()
	await transport.close()
})

it('drains the final reply before confirmed group exit and fences unanswered requests at EOF', async () => {
	const f = guestMcpChannel()
	const transport = new PalGuestMcpTransport(async () => f.channel)
	await transport.connect()
	await transport.send(request)
	await transport.send({ ...request, id: 2 })
	const ended = new Promise<void>((resolve) => transport.onClose(resolve))
	f.reply({
		jsonrpc: '2.0',
		id: 1,
		result: { _meta: { 'namzu/outcome': 'settled' }, content: [] },
	})
	f.finish()
	await ended
	expect(f.operations[0]?.complete).toHaveBeenCalledOnce()
	expect(f.operations[0]?.outcomeUnknown).not.toHaveBeenCalled()
	expect(f.operations[1]?.outcomeUnknown).toHaveBeenCalledOnce()
	await transport.close()
})

it('does not accept an invalid ID-only reply as confirmation', async () => {
	const f = guestMcpChannel()
	const transport = new PalGuestMcpTransport(async () => f.channel)
	await transport.connect()
	await transport.send(request)
	const failed = new Promise<Error>((resolve) => transport.onError(resolve))
	f.pushBytes(Buffer.from('{"jsonrpc":"2.0","id":1}\n'))
	expect((await failed).message).toContain('invalid reply')
	expect(f.operations[0]?.complete).not.toHaveBeenCalled()
	expect(f.operations[0]?.outcomeUnknown).toHaveBeenCalledOnce()
	await transport.close()
})

it('does not claim delivery when admission is refused', async () => {
	const f = guestMcpChannel()
	vi.mocked(f.channel.beginOperation).mockRejectedValue(new Error('Operator has control'))
	const transport = new PalGuestMcpTransport(async () => f.channel)
	await transport.connect()
	await expect(transport.send(request)).rejects.toThrow('Operator has control')
	expect(f.channel.write).not.toHaveBeenCalled()
	await transport.close()
})
