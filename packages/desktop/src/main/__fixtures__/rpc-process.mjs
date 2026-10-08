// Isolated transport fixture: no credentials, model, network or shell execution.
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
const pending = new Map()
const harnesses = new Map()
const sessions = new Set()
const liveScopes = new Map()
const models = new Map()
const delayedDiscoveries = []
const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
const reply = (id, result) => send({ id, result })
const discovery = (id, kind, result) => {
	if (process.env.FIXTURE_DELAY_DISCOVERY_FILE && existsSync(process.env.FIXTURE_DELAY_DISCOVERY_FILE) && readFileSync(process.env.FIXTURE_DELAY_DISCOVERY_FILE, 'utf8') === kind) delayedDiscoveries.push({ id, result })
	else reply(id, result)
}
const releaseDiscoveries = () => {
	for (const { id, result } of delayedDiscoveries.splice(0)) reply(id, result)
}
const methods = ['namzu/harnesses/list', 'namzu/harnesses/select', 'namzu/project/status', 'namzu/project/trust', ...(process.env.FIXTURE_NO_UNTRUST ? [] : ['namzu/project/untrust']), 'namzu/conversations/list', 'namzu/conversations/history', 'namzu/providers/status', 'namzu/providers/models', 'namzu/providers/select', 'namzu/jobs/list', 'namzu/jobs/read', 'namzu/jobs/stop', ...(process.env.FIXTURE_LIVE_INPUT ? ['namzu/conversations/input/status', 'namzu/conversations/input'] : []), 'namzu/conversations/rename', 'namzu/conversations/fork', 'namzu/conversations/markdown', 'namzu/project/git', ...(process.env.FIXTURE_NO_CHANGES ? [] : ['namzu/project/changes', 'namzu/project/diff']), 'namzu/conversations/archived', 'namzu/conversations/unarchive']
const lines = createInterface({ input: process.stdin })
lines.on('close', () => process.exit(0))
lines.on('line', (line) => {
	const frame = JSON.parse(line)
	const { id, method, params } = frame
	if (method && process.env.FIXTURE_REQUEST_LOG) appendFileSync(process.env.FIXTURE_REQUEST_LOG, `${JSON.stringify({ method, params })}\n`)
	if (!method) {
		const prompt = pending.get(id)
		if (!prompt) return
		pending.delete(id)
		const scope = liveScopes.get(prompt.sessionId)
		if (scope) {
			if (process.env.FIXTURE_LIVE_INPUT_DELIVERY_FILE && existsSync(process.env.FIXTURE_LIVE_INPUT_DELIVERY_FILE))
				for (const item of scope.inputs.values()) item.status = 'delivered'
			scope.available = false
		}
		send({ method: 'session/update', params: { sessionId: prompt.sessionId, update: { kind: 'agent_message_chunk', text: frame.result.outcome === 'approve' ? 'Approved answer' : frame.result.feedback ? `Declined: ${frame.result.feedback}` : 'Declined answer' } } })
		send({ method: 'session/update', params: { sessionId: prompt.sessionId, update: { kind: 'turn_ended', stopReason: 'end_turn' } } })
		reply(prompt.id, { stopReason: 'end_turn' })
	} else if (method === 'initialize') reply(id, { agentInfo: { name: 'namzu' }, promptAttachments: process.env.FIXTURE_NO_ATTACHMENTS ? undefined : true, promptOptions: process.env.FIXTURE_NO_OPTIONS ? undefined : true, extensions: process.env.FIXTURE_INCOMPATIBLE ? [] : methods })
	else if (method === 'namzu/harnesses/list' || method === 'namzu/harnesses/select') {
		if (method.endsWith('/select')) {
			if (process.env.FIXTURE_ENFORCE_PROVIDER_BINDING && !sessions.has(params.sessionId)) {
				send({ id, error: { code: -32603, message: 'This conversation is not published by this connection.' } }); return
			}
			if (harnesses.get(params.sessionId) !== params.engine) {
				const defaultModel = process.env.FIXTURE_DEFAULT_MODEL_FILE && existsSync(process.env.FIXTURE_DEFAULT_MODEL_FILE)
					? readFileSync(process.env.FIXTURE_DEFAULT_MODEL_FILE, 'utf8') : `${params.engine}-default`
				models.set(params.sessionId, defaultModel)
			}
			harnesses.set(params.sessionId, params.engine)
		}
		const result = {
			selected: harnesses.get(params.sessionId) ?? 'namzu', locked: false,
			engines: ['namzu', 'codex-cli', 'claude-code'].map((id) => ({ id, label: id, available: true })),
		}
		if (method.endsWith('/select')) { reply(id, result); releaseDiscoveries() }
		else discovery(id, 'harness', result)
	}
	else if (method === 'namzu/project/status') reply(id, { cwd: process.cwd(), trusted: !(process.env.FIXTURE_UNTRUSTED_FILE && existsSync(process.env.FIXTURE_UNTRUSTED_FILE)) })
	else if (method === 'namzu/project/untrust') {
		if (process.env.FIXTURE_UNTRUST_FAILS) send({ id, error: { code: -32603, message: 'The isolated fixture could not update trust.' } })
		else reply(id, process.env.FIXTURE_STILL_TRUSTED_BY ? { cwd: params.cwd, removed: true, trusted: true, stillTrustedBy: process.env.FIXTURE_STILL_TRUSTED_BY } : { cwd: params.cwd, removed: true, trusted: false })
	}
	else if (method === 'namzu/conversations/list') reply(id, process.env.FIXTURE_LIST_ROWS ? JSON.parse(process.env.FIXTURE_LIST_ROWS) : [])
	else if (method === 'namzu/conversations/rename') reply(id, { title: params.title || 'Derived title' })
	else if (method === 'namzu/conversations/fork') reply(id, { id: `fork-${randomUUID()}`, title: 'Forked conversation (fork)' })
	else if (method === 'namzu/conversations/archived') reply(id, process.env.FIXTURE_ARCHIVED_ROWS ? JSON.parse(process.env.FIXTURE_ARCHIVED_ROWS) : [])
	else if (method === 'namzu/conversations/unarchive') reply(id, { id: params.sessionId, title: 'Restored title', updatedAt: '2026-10-05T00:00:00.000Z' })
	else if (method === 'namzu/conversations/markdown') reply(id, { markdown: '# Exported', truncated: false })
	else if (method === 'namzu/project/git') reply(id, process.env.FIXTURE_NO_GIT ? null : { branch: 'main', subject: 'Initial commit' })
	else if (method === 'namzu/project/changes') reply(id, process.env.FIXTURE_CHANGES ? JSON.parse(process.env.FIXTURE_CHANGES) : { files: [{ path: 'a.ts', status: 'modified', added: 2, removed: 1 }], truncated: false })
	else if (method === 'namzu/project/diff') reply(id, process.env.FIXTURE_DIFF ? JSON.parse(process.env.FIXTURE_DIFF) : { before: 'old\n', after: 'new\n', binary: false, truncated: false })
	else if (method === 'namzu/conversations/history') {
		if (process.env.FIXTURE_HISTORY_MODE === 'missing') send({ id, error: { code: -32603, message: `Conversation ${params.sessionId} was not found — load conversation history rejected` } })
		else if (process.env.FIXTURE_HISTORY_MODE === 'foreign') send({ id, error: { code: -32603, message: `Conversation ${params.sessionId} does not belong to this workspace — load conversation history rejected` } })
		else if (process.env.FIXTURE_HISTORY_MODE === 'unreadable') send({ id, error: { code: -32603, message: 'The fixture journal could not be read.' } })
		else if (process.env.FIXTURE_HISTORY_MODE === 'wrong-session') send({ id, error: { code: -32603, message: 'Conversation other-session was not found — load conversation history rejected' } })
		else reply(id, { messages: [], partial: process.env.FIXTURE_HISTORY_MODE === 'partial' })
	}
	else if (method === 'namzu/providers/status' || method === 'namzu/providers/select') {
		if (process.env.FIXTURE_ENFORCE_PROVIDER_BINDING && params?.sessionId && !sessions.has(params.sessionId)) {
			 send({ id, error: { code: -32603, message: 'This conversation is not published by this connection.' } }); return
		}
		const engine = harnesses.get(params?.sessionId)
		if (method.endsWith('/status') && process.env.FIXTURE_REJECT_METADATA_FILE && existsSync(process.env.FIXTURE_REJECT_METADATA_FILE)) {
			if (readFileSync(process.env.FIXTURE_REJECT_METADATA_FILE, 'utf8') === 'empty') reply(id, { available: [], selected: null })
			else send({ id, error: { code: -32603, message: 'The isolated fixture could not read this engine’s model metadata.' } })
			return
		}
		if (method.endsWith('/select')) {
			if (process.env.FIXTURE_REJECT_SELECTION_FILE && existsSync(process.env.FIXTURE_REJECT_SELECTION_FILE)) {
				send({ id, error: { code: -32603, message: 'This model is no longer available. Your draft is retained.' } }); return
			}
			if ((['codex-cli', 'claude-code'].includes(params.provider) && engine !== params.provider) || (engine && engine !== 'namzu' && params.provider !== engine)) {
				send({ id, error: { code: -32603, message: 'Select this engine in the conversation first.' } }); return
			}
			models.set(params.sessionId, params.model)
			reply(id, {})
			releaseDiscoveries()
		} else discovery(id, 'provider', engine && engine !== 'namzu' ? {
			available: [{ id: engine, label: engine, defaultModel: `${engine}-default` }],
			selected: { id: engine, model: models.get(params.sessionId) },
		} : process.env.FIXTURE_LIST_PROVIDER ? {
			available: [{ id: 'fixture', label: process.env.FIXTURE_LIST_PROVIDER, defaultModel: 'fixture-default' }],
			selected: null,
		} : { available: [], selected: null })
	}
	else if (method === 'namzu/providers/models' && process.env.FIXTURE_MODELS_FILE && existsSync(process.env.FIXTURE_MODELS_FILE)) {
		const content = readFileSync(process.env.FIXTURE_MODELS_FILE, 'utf8')
		if (content === 'throw') send({ id, error: { code: -32603, message: 'The isolated fixture could not list models.' } })
		else if (content === 'empty') reply(id, { models: [], notice: 'The provider catalogue could not be loaded. Refresh the list to retry.' })
		else reply(id, { models: JSON.parse(content), notice: null })
	}
	else if (method === 'namzu/providers/models' && process.env.FIXTURE_MODELS_DELAY_MS) setTimeout(() => reply(id, { models: [{ id: 'alpha', label: 'Alpha' }], notice: null }), Number(process.env.FIXTURE_MODELS_DELAY_MS))
	else if (method === 'namzu/providers/models') reply(id, { models: [{ id: `${params.provider}-${params.sessionId ?? 'project'}`, label: 'Configured fixture model' }], notice: null })
	else if (method === 'session/load') { sessions.add(params.sessionId); reply(id, { sessionId: params.sessionId }) }
	else if (method === 'session/new') { const sessionId = `session-${randomUUID()}`; sessions.add(sessionId); reply(id, { sessionId }) }
	else if (method === 'session/prompt') {
		if (process.env.FIXTURE_LIVE_INPUT) liveScopes.set(params.sessionId, { scopeId: randomUUID(), available: true, inputs: new Map() })
		if (params.prompt === 'Fail turn with fixture') { reply(id, { stopReason: 'error', history: { messages: ['PRIVATE_TURN_HISTORY_FIXTURE'] } }); return }
		if (params.prompt === 'Reject turn with fixture') { send({ id, error: { code: -32603, message: 'The isolated fixture rejected this prompt.' } }); return }
		if (params.prompt === 'Pause turn with fixture') { reply(id, { stopReason: 'cancelled', reason: 'paused' }); return }
		if (params.prompt === 'Provider pause with fixture') {
			send({ method: 'session/update', params: { sessionId: params.sessionId, update: { kind: 'turn_ended', stopReason: 'cancelled', reason: 'paused', error: 'zen — could not reach the provider: model "space-bunny-free": request timed out' } } })
			reply(id, { stopReason: 'cancelled', reason: 'paused' }); return
		}
		if (params.prompt === 'Break connection') { process.exit(0); return }
		const requestId = `review-${params.sessionId}-${id}`
		pending.set(requestId, { id, sessionId: params.sessionId })
		send({ id: requestId, method: 'session/request_permission', params: { sessionId: params.sessionId, toolCalls: [{ id: requestId, name: 'fixture-tool', input: { prompt: params.prompt, ...(process.env.FIXTURE_ENFORCE_PROVIDER_BINDING ? { engine: harnesses.get(params.sessionId) ?? 'namzu', model: models.get(params.sessionId) } : {}), ...(params.attachments?.length ? { attachments: params.attachments } : {}) }, isDestructive: false, ...(process.env.FIXTURE_PREVIEW ? { preview: JSON.parse(process.env.FIXTURE_PREVIEW) } : {}) }] } })
	} else if (method === 'session/cancel') {
		const scope = liveScopes.get(params.sessionId)
		if (scope) scope.available = false
		for (const [requestId, prompt] of pending) {
			if (prompt.sessionId !== params.sessionId) continue
			pending.delete(requestId)
			reply(prompt.id, { stopReason: 'cancelled' })
		}
		reply(id, {})
	} else if (method === 'namzu/conversations/input/status') {
		const scope = liveScopes.get(params.sessionId)
		if (params.scopeId && (!scope || params.scopeId !== scope.scopeId)) { send({ id, error: { code: -32602, message: 'Unknown live input scope.' } }); return }
		if (scope?.inputs.size && process.env.FIXTURE_LIVE_INPUT_MODE_FILE && existsSync(process.env.FIXTURE_LIVE_INPUT_MODE_FILE) && readFileSync(process.env.FIXTURE_LIVE_INPUT_MODE_FILE, 'utf8') === 'lost-ack-and-status') { send({ id, error: { code: -32603, message: 'Status unavailable in isolated fixture.' } }); return }
		reply(id, scope ? { available: scope.available, scopeId: scope.scopeId, inputs: [...scope.inputs.values()] } : { available: false, inputs: [] })
	} else if (method === 'namzu/conversations/input') {
		const scope = liveScopes.get(params.sessionId)
		if (!scope?.available || scope.scopeId !== params.scopeId) { send({ id, error: { code: -32602, message: 'Live input scope is closed.' } }); return }
		if (process.env.FIXTURE_LIVE_INPUT_MODE_FILE && existsSync(process.env.FIXTURE_LIVE_INPUT_MODE_FILE) && readFileSync(process.env.FIXTURE_LIVE_INPUT_MODE_FILE, 'utf8') === 'reject-before-admit') { send({ id, error: { code: -32603, message: 'Input refused before admission.' } }); return }
		const previous = scope.inputs.get(params.inputId)
		if (previous && previous.prompt !== params.prompt) { send({ id, error: { code: -32602, message: 'Live input ID was reused for different text.' } }); return }
		if (!previous) scope.inputs.set(params.inputId, { id: params.inputId, prompt: params.prompt, status: 'pending' })
		if (process.env.FIXTURE_LIVE_INPUT_MODE_FILE && existsSync(process.env.FIXTURE_LIVE_INPUT_MODE_FILE) && readFileSync(process.env.FIXTURE_LIVE_INPUT_MODE_FILE, 'utf8') === 'lost-ack-and-status') { send({ id, error: { code: -32603, message: 'ACK lost in isolated fixture.' } }); return }
		reply(id, { accepted: true, scopeId: scope.scopeId, inputId: params.inputId })
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
