import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { RuntimeClient } from './rpc-client.js'
const clients: RuntimeClient[] = []
const fixture = fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))
function client(env = process.env) {
	const runtime = new RuntimeClient(process.cwd(), {
		program: process.execPath,
		args: [fixture],
		env,
	})
	clients.push(runtime)
	return runtime
}
afterEach(async () => {
	await Promise.all(clients.splice(0).map((runtime) => runtime.close()))
})
it('decodes a response split within UTF-8 and correlates actual process replies', async () => {
	const runtime = client()
	await runtime.start()
	expect(await runtime.request('test/echo')).toBe('Türkçe 🧪')
})
it('rejects all pending callers when the process exits', async () => {
	const runtime = client()
	await runtime.start()
	const pending = expect(runtime.request('test/wait', {}, 0)).rejects.toThrow('connection closed')
	const exit = expect(runtime.request('test/exit')).rejects.toThrow('connection closed')
	await Promise.all([pending, exit])
})
it('finishes shutdown after the owned process has already closed from a signal', async () => {
	const runtime = client()
	await runtime.start()
	await expect(runtime.request('test/signal')).rejects.toThrow('connection closed')
	// Await the actual close completion; an already emitted close event cannot
	// be awaited again. Vitest's timeout catches a genuine stalled shutdown.
	await runtime.close()
	await runtime.close()
})
it('reports malformed protocol output and rejects a pending prompt', async () => {
	const runtime = client()
	await runtime.start()
	await expect(runtime.request('test/malformed')).rejects.toThrow()
	await expect(runtime.request('test/echo')).rejects.toThrow('not connected')
})
it('fails initialization before exposing an incompatible runtime', async () => {
	await expect(client({ ...process.env, FIXTURE_INCOMPATIBLE: '1' }).start()).rejects.toThrow(
		'Update Namzu',
	)
})
