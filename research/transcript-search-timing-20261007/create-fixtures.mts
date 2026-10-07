/** Public fixture receipts from a real, isolated SDK journal; no model/native application calls. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
	DiskSessionLog,
	createAssistantMessage,
	createUserMessage,
	generateMessageId,
	generateTurnId,
} from '../../packages/sdk/dist/index.js'
import { removeTempDir } from '../../packages/cli/src/__fixtures__/temp-dir.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../../packages/cli/src/commands/acp.js'
import { createDesktopHostExtensions } from '../../packages/cli/src/commands/desktop-host.js'
import {
	closeSessions,
	loadConversationSnapshot,
	openSessions,
	startConversation,
} from '../../packages/cli/src/integrations/sessions/store.js'
import { decideHeadlessTrust } from '../../packages/cli/src/permissions/headless-trust.js'
import { toAcpSessionUpdate } from '../../packages/sdk/src/bridge/acp/update.js'
import { createToolPresenter, type ToolPresenter } from '../../packages/sdk/src/registry/tool/presentation.js'

const repo = resolve(process.argv[2] ?? '.')
const artifacts = join(repo, 'research/transcript-search-timing-20261007/artifacts')
await mkdir(artifacts, { recursive: true })
const fixtureRoot = await mkdtemp(join(tmpdir(), 'namzu-transcript-clock-proof-'))
const cwd = join(fixtureRoot, 'project')
const savedHome = process.env.NAMZU_HOME
await mkdir(join(cwd, '.git'), { recursive: true })
await mkdir(join(fixtureRoot, 'state'))
process.env.NAMZU_HOME = join(fixtureRoot, 'state')
let providerRequests = 0
const runtime = createCliAcpRuntime(
	{ config: {}, formatter: { name: 'text', print() {}, info() {}, error() {} } },
	{
		decideTrust: decideHeadlessTrust,
		resolveSession: async () => { providerRequests++; throw new Error('Provider execution forbidden in this fixture.') },
	} as unknown as AcpRuntimeDependencies,
)
const host = createDesktopHostExtensions(runtime, cwd)
host['namzu/project/trust']({ confirmed: true, cwd })
const state = await openSessions(cwd)
const sessionId = await startConversation(state)
const log = DiskSessionLog.at(state.paths, { sessionId })
const lease = await log.claim({ holder: 'research:transcript-clock-proof', ttlMs: 30_000 })
assert.ok(lease)
try {
	const turnId = generateTurnId()
	const userMessageId = generateMessageId()
	await log.beginTurn(lease, { turnId, userMessageId, config: { model: 'no-provider-fixture', timeoutMs: 0, tokenBudget: 0 } })
	await log.append(lease, { type: 'message', turnId, messageId: userMessageId, role: 'user', content: createUserMessage('Find RunPod H100 hourly prices and keep the source links.') })
	const search = { id: 'provider-search-fixture', name: 'web_search', status: 'running' as const }
	const searchDone = { ...search, status: 'completed' as const, query: 'RunPod H100 GPU hourly pricing', results: 9 }
	const runningRecord = await log.append(lease, { type: 'hosted_tool', turnId, iteration: 0, tool: search })
	const completedRecord = await log.append(lease, { type: 'hosted_tool', turnId, iteration: 0, tool: searchDone })
	const actionId = generateMessageId()
	await log.append(lease, { type: 'tool_executing', turnId, toolUseId: actionId, toolName: 'read', input: { path: 'gpu-rates.txt' } })
	await log.append(lease, {
		type: 'tool_completed', turnId, toolUseId: actionId, toolName: 'read', result: 'Synthetic recorded data only.', isError: false, durationMs: 123,
		presentation: { kind: 'terminal', command: 'Read gpu-rates.txt', output: 'Recorded fixture rate: review the primary source before acting.' },
	})
	const checkActionId = generateMessageId()
	await log.append(lease, { type: 'tool_executing', turnId, toolUseId: checkActionId, toolName: 'bash', input: { command: 'check saved results' } })
	await log.append(lease, {
		type: 'tool_completed', turnId, toolUseId: checkActionId, toolName: 'bash', result: 'Recorded checks passed.', isError: false, durationMs: 876,
		presentation: { kind: 'terminal', command: 'Check saved results', output: 'Recorded checks passed.' },
	})
	const technicalReceipts = []
	const conversationPresenter = createToolPresenter({ get: () => undefined })
	for (const action of [
		{ query: 'web_search', durationMs: 321 },
		{ query: 'flexprice', durationMs: 654 },
	]) {
		const name = 'search_conversation'
		const receipt = JSON.stringify({ matches: [{ text: `Synthetic earlier ${action.query} observation.`, recordKind: 'assistant_message' }], incomplete: false, unavailable: 0, query: action.query })
		const toolUseId = generateMessageId()
		const executing = { type: 'tool_executing' as const, turnId, toolUseId, toolName: name, input: { query: action.query } }
		const completed = { type: 'tool_completed' as const, turnId, toolUseId, toolName: name, result: receipt, isError: false, durationMs: action.durationMs }
		const pendingUpdate = toAcpSessionUpdate(executing, conversationPresenter)
		const completedUpdate = toAcpSessionUpdate(completed, conversationPresenter)
		assert.equal(pendingUpdate?.kind, 'tool_call')
		assert.equal(completedUpdate?.kind, 'tool_call')
		const started = await log.append(lease, executing)
		const ended = await log.append(lease, { ...completed, presentation: completedUpdate.view })
		technicalReceipts.push({ toolUseId, name, ...action, receipt, startedAt: started.record.ts, endedAt: ended.record.ts, pendingUpdate, completedUpdate })
	}
	const answerId = generateMessageId()
	await log.append(lease, {
		type: 'message', turnId, messageId: answerId, role: 'assistant',
		content: createAssistantMessage([
			'The search returned 9 sources. Check [RunPod pricing](https://www.runpod.io/pricing) and [RunPod docs](https://docs.runpod.io/).',
			'Inline source: `https://docs.runpod.io/serverless/overview`.',
			'Unsafe links stay inert: [Local file](file:///etc/passwd), [Script](javascript:alert%281%29), [Credentials](https://user:password@example.invalid/).',
			'Inert code: `file:///etc/passwd`, `javascript:alert(1)`, `https://user:password@example.invalid/`, `curl https://example.invalid/api`.',
			'```text\nhttps://www.runpod.io/console\n```',
		].join('\n\n')),
	})
	await log.append(lease, { type: 'turn_completed', turnId, result: 'Synthetic public answer.', stopReason: 'end_turn', settlement: {
		iterations: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 },
		cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 }, durationMs: 4321, resultSource: 'model', abandonedTaskIds: [], abandonedJobIds: [], status: 'completed',
	} })
	const snapshot = await loadConversationSnapshot(state, sessionId)
	const history = await host['namzu/conversations/history']({ sessionId })
	const repeated = await host['namzu/conversations/history']({ sessionId })
	assert.deepEqual(history, repeated)
	const userRecord = snapshot.records.find(row => row.type === 'message' && row.messageId === userMessageId)
	const answerRecord = snapshot.records.find(row => row.type === 'message' && row.messageId === answerId)
	assert.ok(userRecord && answerRecord)
	assert.equal(history.messages[0]?.time?.at, Date.parse(userRecord.ts))
	assert.equal(history.messages[1]?.time?.at, Date.parse(answerRecord.ts))
	assert.equal(history.messages[0]?.messageId, userMessageId)
	assert.equal(history.messages[1]?.messageId, answerId)
	assert.deepEqual(history.messages.map(message => message.time?.source), ['journal', 'journal'])
	const presenter = {
		presentCall() { throw new Error('No local tool presentation expected.') },
		presentResult() { throw new Error('No local tool presentation expected.') },
	} as ToolPresenter
	const map = (tool: typeof search | typeof searchDone) => toAcpSessionUpdate({ type: 'hosted_tool', turnId, iteration: 0, tool }, presenter)
	const livePending = map(search)
	const liveCompleted = map(searchDone)
	assert.equal(livePending?.kind, 'tool_call')
	assert.equal(liveCompleted?.kind, 'tool_call')
	assert.equal(providerRequests, 0)
	await writeFile(join(artifacts, 'journal-fixtures.json'), `${JSON.stringify({
		schema: 'namzu.transcript-browser-fixtures.v1',
		fixtureSource: 'Real DiskSessionLog records and current CLI history projection, isolated task-owned synthetic conversation.',
		actualUserConversationRead: false, nativeActions: 0, providerRequests,
		journalClock: { user: userRecord.ts, answer: answerRecord.ts, searchStarted: runningRecord.record.ts, searchEnded: completedRecord.record.ts },
		coldHistory: history,
		legacyHistory: { messages: [{ role: 'user', text: 'An older conversation has no recorded clock.' }, { role: 'assistant', text: 'Keep its clock unknown.' }], partial: false },
		livePending, liveCompleted, technicalReceipts,
	}, null, 2)}\n`)
} finally {
	await log.release(lease)
	closeSessions(state)
	await runtime.close()
	if (savedHome === undefined) delete process.env.NAMZU_HOME
	else process.env.NAMZU_HOME = savedHome
	removeTempDir(fixtureRoot)
}
console.log(JSON.stringify({ passed: true, nativeActions: 0, providerRequests }))
