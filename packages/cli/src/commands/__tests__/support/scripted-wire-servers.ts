import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Two local services for a process-level test: one speaks the Messages wire and one the
 * chat-completions wire. No network, no model, no timing: each answers the request it gets
 * with what its script says, and records the request for the test to read.
 */

export interface ScriptedStep {
	/** Answer with this HTTP status instead of a reply. */
	status?: number
	text?: string
}

export interface ScriptedService {
	readonly url: string
	readonly requests: Record<string, any>[]
	/** The answer to the next request; the last step repeats. */
	script: ScriptedStep[]
	close(): Promise<void>
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<Server> {
	const server = createServer(handler)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	return server
}

function readBody(req: import('node:http').IncomingMessage): Promise<Record<string, any>> {
	return new Promise((resolve) => {
		let body = ''
		req.on('data', (chunk) => {
			body += chunk
		})
		req.on('end', () => resolve(body ? JSON.parse(body) : {}))
	})
}

function service(
	server: Server,
	requests: Record<string, any>[],
	live: { script: ScriptedStep[] },
) {
	const { port } = server.address() as AddressInfo
	const handle: ScriptedService = {
		url: `http://127.0.0.1:${port}`,
		requests,
		get script() {
			return live.script
		},
		set script(next: ScriptedStep[]) {
			live.script = next
		},
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections()
				server.close(() => resolve())
			}),
	}
	return handle
}

export async function messagesService(script: ScriptedStep[]): Promise<ScriptedService> {
	const requests: Record<string, any>[] = []
	const live = { script }
	const server = await listen(async (req, res) => {
		const request = await readBody(req)
		if (!req.url?.includes('/messages')) {
			res.writeHead(404).end()
			return
		}
		requests.push(request)
		const steps = live.script
		const step = steps[Math.min(requests.length - 1, steps.length - 1)] ?? { text: 'ok' }
		if (step.status) {
			res.writeHead(step.status, { 'content-type': 'application/json', 'retry-after': '0' })
			res.end(
				JSON.stringify({
					type: 'error',
					error: { type: 'rate_limit_error', message: 'slow down' },
				}),
			)
			return
		}
		res.writeHead(200, { 'content-type': 'text/event-stream' })
		const send = (type: string, data: object) =>
			res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
		send('message_start', {
			message: {
				id: 'msg',
				type: 'message',
				role: 'assistant',
				model: request.model,
				content: [],
				stop_reason: null,
				usage: { input_tokens: 5, output_tokens: 1 },
			},
		})
		send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
		send('content_block_delta', {
			index: 0,
			delta: { type: 'text_delta', text: step.text ?? 'ok' },
		})
		send('content_block_stop', { index: 0 })
		send('message_delta', {
			delta: { stop_reason: 'end_turn', stop_sequence: null },
			usage: { output_tokens: 3 },
		})
		send('message_stop', {})
		res.end()
	})
	return service(server, requests, live)
}

export async function chatService(script: ScriptedStep[]): Promise<ScriptedService> {
	const requests: Record<string, any>[] = []
	const live = { script }
	const server = await listen(async (req, res) => {
		const request = await readBody(req)
		if (!req.url?.includes('/chat/completions')) {
			res.writeHead(404).end()
			return
		}
		requests.push(request)
		const steps = live.script
		const step = steps[Math.min(requests.length - 1, steps.length - 1)] ?? { text: 'ok' }
		if (step.status) {
			res.writeHead(step.status, { 'content-type': 'application/json', 'retry-after': '0' })
			res.end(JSON.stringify({ error: { message: 'slow down', type: 'rate_limit_error' } }))
			return
		}
		res.writeHead(200, { 'content-type': 'text/event-stream' })
		const chunk = (delta: object, finish: string | null) =>
			`data: ${JSON.stringify({
				id: 'chatcmpl',
				object: 'chat.completion.chunk',
				created: 1,
				model: request.model,
				choices: [{ index: 0, delta, finish_reason: finish }],
			})}\n\n`
		res.write(chunk({ role: 'assistant', content: step.text ?? 'ok' }, null))
		res.write(chunk({}, 'stop'))
		res.write(
			`data: ${JSON.stringify({
				id: 'chatcmpl',
				object: 'chat.completion.chunk',
				created: 1,
				model: request.model,
				choices: [],
				usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
			})}\n\n`,
		)
		res.end('data: [DONE]\n\n')
	})
	return service(server, requests, live)
}
