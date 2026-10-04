// Isolated transport fixture: no credentials, model, network or shell execution.
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
const pending = new Map()
const harnesses = new Map()
const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
const reply = (id, result) => send({ id, result })
const methods = ['namzu/harnesses/list', 'namzu/harnesses/select', 'namzu/project/status', 'namzu/project/trust', 'namzu/conversations/list', 'namzu/conversations/history', 'namzu/providers/status', 'namzu/providers/models', 'namzu/providers/select', 'namzu/jobs/list', 'namzu/jobs/read', 'namzu/jobs/stop']
const lines = createInterface({ input: process.stdin })
lines.on('close', () => process.exit(0))
lines.on('line', (line) => {
	const frame = JSON.parse(line)
	const { id, method, params } = frame
	if (!method) {
		const prompt = pending.get(id)
		if (!prompt) return
		pending.delete(id)
		send({ method: 'session/update', params: { sessionId: prompt.sessionId, update: { kind: 'agent_message_chunk', text: frame.result.outcome === 'approve' ? 'Approved answer' : 'Declined answer' } } })
		send({ method: 'session/update', params: { sessionId: prompt.sessionId, update: { kind: 'turn_ended', stopReason: 'end_turn' } } })
		reply(prompt.id, { stopReason: 'end_turn' })
	} else if (method === 'initialize') reply(id, { agentInfo: { name: 'namzu' }, promptAttachments: process.env.FIXTURE_NO_ATTACHMENTS ? undefined : true, promptOptions: process.env.FIXTURE_NO_OPTIONS ? undefined : true, extensions: process.env.FIXTURE_INCOMPATIBLE ? [] : methods })
	else if (method === 'namzu/harnesses/list' || method === 'namzu/harnesses/select') {
		if (method.endsWith('/select')) harnesses.set(params.sessionId, params.engine)
		reply(id, {
			selected: harnesses.get(params.sessionId) ?? 'namzu', locked: false,
			engines: ['namzu', 'codex-cli', 'claude-code'].map((id) => ({ id, label: id, available: true })),
		})
	}
	else if (method === 'namzu/project/status') reply(id, { cwd: process.cwd(), trusted: true })
	else if (method === 'namzu/conversations/list') reply(id, [])
	else if (method === 'namzu/conversations/history') reply(id, { messages: [], partial: false })
	else if (method === 'namzu/providers/models') reply(id, { models: [{ id: `${params.provider}-${params.sessionId ?? 'project'}`, label: 'Configured fixture model' }], notice: null })
	else if (method === 'session/load') reply(id, { sessionId: params.sessionId })
	else if (method === 'session/new') reply(id, { sessionId: `session-${randomUUID()}` })
	else if (method === 'session/prompt') {
		if (params.prompt === 'Fail turn with fixture') { reply(id, { stopReason: 'error', history: { messages: ['PRIVATE_TURN_HISTORY_FIXTURE'] } }); return }
		if (params.prompt === 'Reject turn with fixture') { send({ id, error: { code: -32603, message: 'The isolated fixture rejected this prompt.' } }); return }
		if (params.prompt === 'Pause turn with fixture') { reply(id, { stopReason: 'cancelled', reason: 'paused' }); return }
		if (params.prompt === 'Break connection') { process.exit(0); return }
		const requestId = `review-${params.sessionId}-${id}`
		pending.set(requestId, { id, sessionId: params.sessionId })
		send({ id: requestId, method: 'session/request_permission', params: { sessionId: params.sessionId, toolCalls: [{ id: requestId, name: 'fixture-tool', input: { prompt: params.prompt, ...(params.attachments?.length ? { attachments: params.attachments } : {}) }, isDestructive: false }] } })
	} else if (method === 'session/cancel') {
		for (const [requestId, prompt] of pending) {
			if (prompt.sessionId !== params.sessionId) continue
			pending.delete(requestId)
			reply(prompt.id, { stopReason: 'cancelled' })
		}
		reply(id, {})
	} else if (method === 'test/echo') {
		const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result: 'Türkçe 🧪' })}\n`)
		const split = bytes.indexOf(Buffer.from('ü')) + 1
		process.stdout.write(bytes.subarray(0, split), () => process.stdout.write(bytes.subarray(split)))
	} else if (method === 'test/malformed') process.stdout.write('invalid-json\n')
	else if (method === 'namzu/pals/computer/start') send({ id, error: { code: -32603, message: 'A local Docker engine running Linux containers and the image are required. Synthetic token=SECRET_DIAGNOSTIC_FIXTURE and private prompt payload must not be retained.' } })
	else if (method === 'test/exit') process.exit(0)
	else if (method === 'test/signal') process.kill(process.pid, 'SIGTERM')
	else if (method === 'test/wait') { /* pending until transport closes */ }
	else reply(id, {})
})
