// Isolated retry transport fixture: no provider, credentials, guest or network.
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const methods = [
	'namzu/project/status', 'namzu/project/trust', 'namzu/conversations/list',
	'namzu/conversations/history', 'namzu/providers/status', 'namzu/providers/select',
	'namzu/jobs/list', 'namzu/jobs/read', 'namzu/jobs/stop',
	...(process.env.FIXTURE_RETRY_MODE === 'old' ? [] : ['namzu/sessions/retry-status', 'namzu/sessions/retry']),
]
const sessions = new Map()
const pending = new Map()
const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
const reply = (id, result) => send({ id, result })
const update = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } })
const fail = (id, message) => send({ id, error: { code: -32603, message } })
const target = { turnId: 'original-turn', checkpointId: 'original-checkpoint' }
const notice = 'This provider request has unresolved token usage. Its original turn is retained.'
const status = (session) => !session?.paused ? {} : process.env.FIXTURE_RETRY_MODE === 'unsafe' ? { notice } : { retry: target }
const pause = (id, sessionId) => {
	const session = sessions.get(sessionId)
	session.paused = true
	update(sessionId, { kind: 'turn_ended', ...target, stopReason: 'cancelled', reason: 'paused', error: 'zen — request timed out' })
	reply(id, { stopReason: 'cancelled', reason: 'paused' })
}
const lines = createInterface({ input: process.stdin })
lines.on('close', () => process.exit(0))
lines.on('line', (line) => {
	const { id, method, params } = JSON.parse(line)
	if (method && process.env.FIXTURE_REQUEST_LOG) appendFileSync(process.env.FIXTURE_REQUEST_LOG, `${JSON.stringify({ method, params })}\n`)
	if (!method) {
		const request = pending.get(id)
		if (!request) return
		pending.delete(id)
		if (request.kind === 'prompt') { pause(request.id, request.sessionId); return }
		const session = sessions.get(request.sessionId)
		session.paused = false
		update(request.sessionId, { kind: 'agent_message_chunk', turnId: target.turnId, messageId: 'answer', text: 'Continued original turn' })
		update(request.sessionId, { kind: 'agent_message', turnId: target.turnId, messageId: 'answer', status: 'completed', stopReason: 'end_turn', content: 'Continued original turn' })
		update(request.sessionId, { kind: 'turn_ended', turnId: target.turnId, stopReason: 'end_turn', reason: 'end_turn', result: 'Continued original turn' })
		reply(request.id, { stopReason: 'end_turn', reason: 'end_turn' })
	} else if (method === 'initialize') reply(id, { agentInfo: { name: 'namzu' }, promptAttachments: true, promptOptions: true, extensions: methods })
	else if (method === 'namzu/project/status') reply(id, { trusted: true })
	else if (method === 'session/new') {
		const sessionId = `session-${randomUUID()}`
		sessions.set(sessionId, { paused: false, messages: [] })
		reply(id, { sessionId })
	} else if (method === 'namzu/conversations/history') reply(id, { messages: sessions.get(params.sessionId)?.messages ?? [], partial: false })
	else if (method === 'namzu/conversations/list') reply(id, [])
	else if (method === 'namzu/sessions/retry-status') reply(id, status(sessions.get(params.sessionId)))
	else if (method === 'namzu/providers/status') reply(id, { available: [], selected: null })
	else if (method === 'session/prompt') {
		const session = sessions.get(params.sessionId)
		if (session.paused) { fail(id, 'The original turn remains paused'); return }
		session.messages.push({ role: 'user', text: params.prompt })
		if (params.prompt === 'Wait for pause') {
			const requestId = `review-${id}`
			pending.set(requestId, { id, sessionId: params.sessionId, kind: 'prompt' })
			send({ id: requestId, method: 'session/request_permission', params: { sessionId: params.sessionId, toolCalls: [] } })
		} else pause(id, params.sessionId)
	} else if (method === 'namzu/sessions/retry') {
		const session = sessions.get(params.sessionId)
		if (!status(session).retry || params.turnId !== target.turnId || params.checkpointId !== target.checkpointId) { fail(id, notice); return }
		const requestId = `review-${id}`
		pending.set(requestId, { id, sessionId: params.sessionId, kind: 'retry' })
		send({ id: requestId, method: 'session/request_permission', params: { sessionId: params.sessionId, toolCalls: [{ id: 'retry-call', name: 'guest-action', input: {}, isDestructive: false }] } })
	} else if (method === 'session/cancel') {
		for (const [requestId, request] of pending) {
			if (request.sessionId !== params.sessionId) continue
			pending.delete(requestId)
			sessions.get(params.sessionId).paused = false
			reply(request.id, { stopReason: 'cancelled', reason: 'cancelled' })
		}
		reply(id, {})
	} else reply(id, {})
})
