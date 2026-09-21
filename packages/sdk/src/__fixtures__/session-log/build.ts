/**
 * Builds the session-log fixtures in this directory, deterministically.
 *
 * The `.jsonl` files beside this module are its output, committed so a reader
 * can open them. `session-log-fixtures.test.ts` rebuilds them and requires the
 * committed bytes to match, so the two cannot drift. After changing a case,
 * regenerate with:
 *
 *     node --import tsx -e "import('./packages/sdk/src/__fixtures__/session-log/build.ts').then((m) => m.writeSessionLogFixtures())"
 *
 * Every id is a fixture UUID and every timestamp is fixed, so the hash chain
 * is stable. A `prev` pointer names the previous line by seq, byte offset,
 * byte length (newline included) and the SHA-256 of those bytes.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureUuid } from '../../test-support/ids.js'

type Body = { readonly type: string; readonly turnId?: string } & Record<string, unknown>

interface Pointer {
	seq: number
	offset: number
	length: number
	sha256: string
}

const HERE = dirname(fileURLToPath(import.meta.url))
const EPOCH = Date.UTC(2026, 8, 21, 9, 0, 0)

export const ids = {
	project: fixtureUuid('fixture:project'),
	tenant: fixtureUuid('fixture:tenant'),
	session: (name: string) => fixtureUuid(`fixture:session:${name}`),
	turn: (name: string) => fixtureUuid(`fixture:turn:${name}`),
	message: (name: string) => fixtureUuid(`fixture:message:${name}`),
	checkpoint: (name: string) => fixtureUuid(`fixture:checkpoint:${name}`),
	record: (session: string, seq: number) => fixtureUuid(`fixture:record:${session}:${seq}`),
}

const usage = (prompt: number, completion: number) => ({
	promptTokens: prompt,
	completionTokens: completion,
	totalTokens: prompt + completion,
	cachedTokens: 0,
	cacheWriteTokens: 0,
})
const cost = (total: number) => ({ totalCost: total, cacheDiscount: 0, unpricedTokens: 0 })
const config = { model: 'fixture-model', tokenBudget: 100_000, timeoutMs: 600_000 }
const settlement = (
	status: 'completed' | 'failed' | 'cancelled',
	extra: Record<string, unknown> = {},
) => ({
	status,
	iterations: 1,
	usage: usage(120, 30),
	cost: cost(0.002),
	durationMs: 1500,
	resultSource: 'model',
	abandonedTaskIds: [],
	abandonedJobIds: [],
	...extra,
})

/** Appends records to one in-memory log and computes the chain as a writer would. */
class LogBuilder {
	readonly #session: string
	readonly #lines: string[] = []
	#offset = 0
	#prev: Pointer | null = null
	#seq = 0

	constructor(sessionName: string) {
		this.#session = ids.session(sessionName)
	}

	get sessionId(): string {
		return this.#session
	}

	/** Pointer to the last record appended. */
	get head(): Pointer {
		if (this.#prev === null) throw new Error('empty log')
		return this.#prev
	}

	append(body: Body): this {
		this.#seq += 1
		const { type, turnId, ...payload } = body
		const record = {
			v: 1,
			type,
			id: ids.record(this.#session, this.#seq),
			sessionId: this.#session,
			...(turnId === undefined ? {} : { turnId }),
			seq: this.#seq,
			ts: new Date(EPOCH + this.#seq * 1000).toISOString(),
			prev: this.#prev,
			gen: 1,
			...payload,
		}
		const line = `${JSON.stringify(record)}\n`
		const bytes = Buffer.from(line, 'utf8')
		this.#prev = {
			seq: this.#seq,
			offset: this.#offset,
			length: bytes.byteLength,
			sha256: createHash('sha256').update(bytes).digest('hex'),
		}
		this.#offset += bytes.byteLength
		this.#lines.push(line)
		return this
	}

	/** One user prompt: `turn_started` then the prompt's `message` record. */
	prompt(turn: string, text: string, extra: Record<string, unknown> = {}): this {
		const turnId = ids.turn(turn)
		return this.append({
			type: 'turn_started',
			turnId,
			userMessageId: ids.message(`${turn}:prompt`),
			config,
			...extra,
		}).append({
			type: 'message',
			turnId,
			messageId: ids.message(`${turn}:prompt`),
			role: 'user',
			kind: 'prompt',
			content: { role: 'user', content: text },
		})
	}

	/** One model message and its iteration bookkeeping. */
	answer(turn: string, text: string): this {
		const turnId = ids.turn(turn)
		const messageId = ids.message(`${turn}:answer`)
		return this.append({ type: 'iteration_started', turnId, iteration: 1 })
			.append({ type: 'message_started', turnId, iteration: 1, messageId })
			.append({
				type: 'message_completed',
				turnId,
				iteration: 1,
				messageId,
				stopReason: 'end_turn',
				content: text,
			})
			.append({
				type: 'message',
				turnId,
				messageId,
				role: 'assistant',
				content: { role: 'assistant', content: text },
			})
			.append({
				type: 'token_usage_updated',
				turnId,
				usage: usage(120, 30),
				cost: cost(0.002),
			})
			.append({ type: 'iteration_completed', turnId, iteration: 1, hasToolCalls: false })
	}

	complete(turn: string, result: string, extra: Record<string, unknown> = {}): this {
		return this.append({
			type: 'turn_completed',
			turnId: ids.turn(turn),
			result,
			stopReason: 'end_turn',
			settlement: settlement('completed', { resultMessageId: ids.message(`${turn}:answer`) }),
			...extra,
		})
	}

	text(): string {
		return this.#lines.join('')
	}
}

const started = (extra: Record<string, unknown> = {}) => ({
	type: 'session_started',
	projectId: ids.project,
	tenantId: ids.tenant,
	cwd: '/work/fixture',
	agent: { id: 'fixture-agent', name: 'Fixture agent' },
	...extra,
})

/** Every fixture, by file name relative to this directory. */
export function buildSessionLogFixtures(): Record<string, string> {
	const files: Record<string, string> = {}

	// valid: two turns, a tool call, an audit record and a bound budget.
	{
		const log = new LogBuilder('valid')
		const t1 = ids.turn('valid-1')
		log
			.append(started())
			.prompt('valid-1', 'List the files.', {
				budget: { rootSessionId: log.sessionId, rootTurnId: t1, accountId: fixtureUuid('acct:1') },
			})
			.append({
				type: 'budget_bound',
				turnId: t1,
				rootSessionId: log.sessionId,
				rootTurnId: t1,
				accountId: fixtureUuid('acct:1'),
			})
			.append({
				type: 'tool_executing',
				turnId: t1,
				toolUseId: 'toolu_fixture_1',
				toolName: 'ls',
				input: { path: '.' },
			})
			.append({
				type: 'tool_completed',
				turnId: t1,
				toolUseId: 'toolu_fixture_1',
				toolName: 'ls',
				result: 'a.txt\nb.txt',
				isError: false,
				durationMs: 4,
			})
			.append({
				type: 'message',
				turnId: t1,
				messageId: ids.message('valid-1:tool'),
				role: 'tool',
				content: { role: 'tool', content: 'a.txt\nb.txt', toolCallId: 'toolu_fixture_1' },
			})
			.answer('valid-1', 'Two files: a.txt and b.txt.')
			.append({
				type: 'audit',
				turnId: t1,
				auditId: fixtureUuid('audit:1'),
				actor: { kind: 'agent', agentId: 'fixture-agent', tenantId: ids.tenant },
				action: 'tool.ls',
				outcome: 'success',
			})
			.complete('valid-1', 'Two files: a.txt and b.txt.')
			.prompt('valid-2', 'Thanks.')
			.answer('valid-2', 'You are welcome.')
			.complete('valid-2', 'You are welcome.')
		files['valid.jsonl'] = log.text()
	}

	// torn-tail: a crash cut the last append off mid-line.
	{
		const log = new LogBuilder('torn-tail')
		log.append(started()).prompt('torn-1', 'Start.').answer('torn-1', 'Started.')
		const whole = log.text()
		const tail = `${JSON.stringify({ v: 1, type: 'turn_completed', id: ids.record(log.sessionId, 99) })}`
		files['torn-tail.jsonl'] = whole + tail.slice(0, 40)
	}

	// repaired: the torn tail truncated on open, then recorded.
	{
		const log = new LogBuilder('repaired')
		log.append(started()).prompt('repaired-1', 'Start.').answer('repaired-1', 'Started.')
		log.append({
			type: 'log_repaired',
			turnId: ids.turn('repaired-1'),
			truncatedBytes: 40,
			lastGoodSeq: 9,
		})
		files['repaired.jsonl'] = log.text()
	}

	// broken-chain: record 4's prev hash was altered; every line still parses.
	{
		const log = new LogBuilder('broken-chain')
		log.append(started()).prompt('broken-1', 'Start.').answer('broken-1', 'Started.')
		const lines = log.text().split('\n')
		const fourth = JSON.parse(lines[3] as string) as { prev: Pointer }
		const flipped = fourth.prev.sha256.startsWith('0') ? '1' : '0'
		fourth.prev.sha256 = flipped + fourth.prev.sha256.slice(1)
		lines[3] = JSON.stringify(fourth)
		files['broken-chain.jsonl'] = lines.join('\n')
	}

	// compaction: an automatic pass inside a turn, then a manual one between turns.
	{
		const log = new LogBuilder('compaction')
		const t1 = ids.turn('compaction-1')
		log
			.append(started())
			.prompt('compaction-1', 'Summarise the repository.')
			.answer('compaction-1', 'It is a TypeScript monorepo.')
			.append({
				type: 'compaction_shed',
				turnId: t1,
				iteration: 1,
				messages: [{ role: 'user', content: 'Summarise the repository.' }],
				reason: 'threshold',
			})
			.append({
				type: 'compaction',
				turnId: t1,
				compactionId: fixtureUuid('compaction:1'),
				strategy: 'summarize',
				trigger: 'auto',
				replacesSeqRange: [3, 3],
				summary: [
					{
						role: 'system',
						content: 'The user asked for a summary.',
						source: { type: 'compaction-summary' },
					},
				],
				keptMessageIds: [ids.message('compaction-1:answer')],
				tokensBefore: 9000,
				tokensAfter: 1200,
			})
			.append({
				type: 'compaction_completed',
				turnId: t1,
				iteration: 1,
				messagesBefore: 2,
				messagesAfter: 2,
				tokensBefore: 9000,
				tokensAfter: 1200,
				measuredBy: 'provider',
				contextWindowTokens: 200_000,
				windowSource: 'model-table',
			})
			.complete('compaction-1', 'It is a TypeScript monorepo.')
			.append({
				type: 'compaction',
				compactionId: fixtureUuid('compaction:2'),
				strategy: 'summarize',
				trigger: 'manual',
				replacesSeqRange: [2, 13],
				summary: [
					{
						role: 'system',
						content: 'Earlier: a repository summary.',
						source: { type: 'compaction-summary' },
					},
				],
				keptMessageIds: [],
				tokensBefore: 1200,
				tokensAfter: 300,
			})
		files['compaction.jsonl'] = log.text()
	}

	// paused-then-resumed: a tool review parks the turn; the same turn resumes.
	{
		const log = new LogBuilder('paused')
		const t1 = ids.turn('paused-1')
		const cp = ids.checkpoint('paused-1')
		log
			.append(started())
			.prompt('paused-1', 'Delete the build directory.')
			.append({ type: 'iteration_started', turnId: t1, iteration: 1 })
			.append({
				type: 'tool_review_requested',
				turnId: t1,
				iteration: 1,
				toolCalls: [{ id: 'toolu_fixture_rm', name: 'bash', input: { command: 'rm -rf build' } }],
			})
		// The checkpoint covers the log through the record just appended.
		const through = log.head
		log
			.append({
				type: 'checkpoint_written',
				turnId: t1,
				checkpointId: cp,
				iteration: 1,
				throughSeq: through.seq,
				throughSha256: through.sha256,
				path: `checkpoints/${cp}.json`,
				docSha256: 'b'.repeat(64),
			})
			.append({
				type: 'decision_requested',
				turnId: t1,
				decisionId: 'decision-1',
				checkpointId: cp,
				request: { type: 'tool_review', checkpointId: cp, toolCalls: [] },
				deadlineAt: new Date(EPOCH + 3_600_000).toISOString(),
			})
			.append({ type: 'turn_paused', turnId: t1, checkpointId: cp, reason: 'awaiting tool review' })
			.append({
				type: 'decision_resolved',
				turnId: t1,
				decisionId: 'decision-1',
				decision: { action: 'approve_tools' },
				resolvedBy: { kind: 'user', userId: fixtureUuid('user:1'), tenantId: ids.tenant },
			})
			.append({
				type: 'turn_resuming',
				turnId: t1,
				fromCheckpointId: cp,
				resolvedDecisionId: 'decision-1',
			})
			.append({ type: 'tool_review_completed', turnId: t1, decision: 'approved' })
			.answer('paused-1', 'Deleted build/.')
			.complete('paused-1', 'Deleted build/.')
		files['paused-then-resumed.jsonl'] = log.text()
	}

	// abandoned: a paused turn closed by abandonTurn; then an interrupted turn
	// closed by beginTurn({ abandonInterrupted: true }) before the next prompt.
	{
		const log = new LogBuilder('abandoned')
		const t1 = ids.turn('abandoned-1')
		const t2 = ids.turn('abandoned-2')
		const cp = ids.checkpoint('abandoned-1')
		const failed = (turnId: string, code: string, message: string) => ({
			type: 'turn_failed',
			turnId,
			error: message,
			failure: { code, message, retryable: false },
			settlement: settlement('failed', {
				iterations: 0,
				durationMs: 0,
				usage: usage(0, 0),
				cost: cost(0),
			}),
		})
		log
			.append(started())
			.prompt('abandoned-1', 'Publish the release.')
			.append({
				type: 'decision_requested',
				turnId: t1,
				decisionId: 'decision-2',
				checkpointId: cp,
				request: { type: 'tool_review', checkpointId: cp, toolCalls: [] },
			})
			.append({ type: 'turn_paused', turnId: t1, checkpointId: cp, reason: 'awaiting tool review' })
			.append({ type: 'decision_expired', turnId: t1, decisionId: 'decision-2' })
			.append(failed(t1, 'abandoned', 'Abandoned by the operator.'))
			.prompt('abandoned-2', 'Try again.')
			.append({ type: 'iteration_started', turnId: t2, iteration: 1 })
			.append(failed(t2, 'interrupted', 'The process running this turn exited.'))
			.prompt('abandoned-3', 'Once more.')
			.answer('abandoned-3', 'Done.')
			.complete('abandoned-3', 'Done.')
		files['abandoned.jsonl'] = log.text()
	}

	// guardrail-replaced: the answer was rewritten; the fold must show the rewrite.
	{
		const log = new LogBuilder('guardrail')
		const t1 = ids.turn('guardrail-1')
		log
			.append(started())
			.prompt('guardrail-1', 'What is the admin password?')
			.answer('guardrail-1', 'The password is hunter2.')
			.append({
				type: 'guardrail_triggered',
				turnId: t1,
				stage: 'output',
				action: 'rewrite',
				guardrail: 'secrets',
				reason: 'credential in output',
			})
			.append({
				type: 'message_replaced',
				turnId: t1,
				targetMessageId: ids.message('guardrail-1:answer'),
				content: { role: 'assistant', content: 'I cannot share credentials.' },
				reason: 'guardrail_rewritten',
			})
			.append({
				type: 'turn_completed',
				turnId: t1,
				result: 'I cannot share credentials.',
				stopReason: 'end_turn',
				settlement: settlement('completed', {
					resultMessageId: ids.message('guardrail-1:answer'),
					resultSource: 'guardrail_rewritten',
				}),
			})
		files['guardrail-replaced.jsonl'] = log.text()
	}

	// child-sessions: a parent turn delegates; the child logs under subagents/.
	{
		const parent = new LogBuilder('parent')
		const child = new LogBuilder('child')
		const t1 = ids.turn('parent-1')
		const childPath = `subagents/${child.sessionId}.jsonl`
		parent
			.append(started())
			.prompt('parent-1', 'Review the diff with a helper.')
			.append({
				type: 'child_session_spawned',
				turnId: t1,
				childSessionId: child.sessionId,
				toolCallId: 'toolu_fixture_task',
				kind: 'agent_spawn',
				description: 'Review the diff',
				path: childPath,
			})
			.append({
				type: 'child_session_messaged',
				turnId: t1,
				childSessionId: child.sessionId,
				messageId: ids.message('child-1:answer'),
			})
			.append({ type: 'child_session_idled', turnId: t1, childSessionId: child.sessionId })
			.append({
				type: 'child_session_ended',
				turnId: t1,
				childSessionId: child.sessionId,
				status: 'completed',
				stopReason: 'end_turn',
				resultMessageId: ids.message('child-1:answer'),
				usage: usage(120, 30),
				cost: cost(0.002),
			})
			.answer('parent-1', 'The helper found no problems.')
			.complete('parent-1', 'The helper found no problems.')
		child
			.append(
				started({
					agent: { id: 'reviewer', name: 'Reviewer', type: 'reviewer' },
					parent: {
						sessionId: parent.sessionId,
						turnId: t1,
						toolCallId: 'toolu_fixture_task',
						rootSessionId: parent.sessionId,
						depth: 1,
						kind: 'agent_spawn',
					},
				}),
			)
			.prompt('child-1', 'Review the diff.')
			.answer('child-1', 'No problems found.')
			.complete('child-1', 'No problems found.')
		files[`child-sessions/${parent.sessionId}.jsonl`] = parent.text()
		files[`child-sessions/${parent.sessionId}/${childPath}`] = child.text()
		files[`child-sessions/${parent.sessionId}/subagents/${child.sessionId}.meta.json`] =
			`${JSON.stringify(
				{
					v: 1,
					kind: 'child-session',
					sessionId: child.sessionId,
					parentSessionId: parent.sessionId,
					parentTurnId: t1,
					rootSessionId: parent.sessionId,
					depth: 1,
					toolCallId: 'toolu_fixture_task',
					agentType: 'reviewer',
					description: 'Review the diff',
					status: 'completed',
					createdAt: new Date(EPOCH).toISOString(),
					endedAt: new Date(EPOCH + 60_000).toISOString(),
				},
				null,
				2,
			)}\n`
	}

	// batch-annotated: two children grouped as one batch with a phase. Child a
	// ends inside the turn that spawned it; child b outlives that turn (it is
	// in the settlement's abandonedTaskIds) and ends while the next turn runs,
	// so its child_session_ended carries no turnId rather than the closed
	// turn's or the running one's.
	{
		const log = new LogBuilder('batch')
		const t1 = ids.turn('batch-1')
		const childEnded = (name: string, turnId?: string) => ({
			type: 'child_session_ended',
			...(turnId === undefined ? {} : { turnId }),
			childSessionId: ids.session(`batch-child-${name}`),
			status: 'completed',
			stopReason: 'end_turn',
			usage: usage(80, 20),
			cost: cost(0.001),
		})
		log.append(started()).prompt('batch-1', 'Audit both packages.')
		for (const name of ['a', 'b']) {
			log.append({
				type: 'child_session_spawned',
				turnId: t1,
				childSessionId: ids.session(`batch-child-${name}`),
				toolCallId: `toolu_fixture_batch_${name}`,
				kind: 'agent_spawn',
				description: `Audit package ${name}`,
				path: `subagents/${ids.session(`batch-child-${name}`)}.jsonl`,
				batch: { batchId: fixtureUuid('batch:1'), name: 'Package audit', phase: 'scan' },
				budgetAccountId: fixtureUuid(`acct:batch:${name}`),
			})
		}
		log
			.append(childEnded('a', t1))
			.answer('batch-1', 'Package a audited; package b is still running.')
			.complete('batch-1', 'Package a audited; package b is still running.', {
				settlement: settlement('completed', {
					resultMessageId: ids.message('batch-1:answer'),
					abandonedTaskIds: ['toolu_fixture_batch_b'],
				}),
			})
			.prompt('batch-2', 'Summarise what you have so far.')
			.append(childEnded('b'))
			.answer('batch-2', 'Both packages audited.')
			.complete('batch-2', 'Both packages audited.')
		files['batch-annotated.jsonl'] = log.text()
	}

	// origin-external-refs: an AG-UI thread, its client run id, and desktop refs.
	{
		const log = new LogBuilder('origin')
		log
			.append(
				started({
					origin: { protocol: 'ag-ui', externalSessionId: 'thread-7f' },
				}),
			)
			.append({
				type: 'session_updated',
				title: 'Release checklist',
				titleSource: 'named',
				externalRefs: {
					add: [
						{ protocol: 'desktop', kind: 'session', externalId: 'desktop:42' },
						{ protocol: 'a2a', kind: 'context', externalId: 'ctx not a uuid' },
					],
				},
			})
			.prompt('origin-1', 'Draft the checklist.', {
				origin: {
					protocol: 'ag-ui',
					externalSessionId: 'thread-7f',
					externalTurnId: 'run-client-1',
					kind: 'prompt',
				},
			})
			.answer('origin-1', 'Here is a draft.')
			.complete('origin-1', 'Here is a draft.')
			.append({
				type: 'session_updated',
				externalRefs: {
					remove: [{ protocol: 'desktop', kind: 'session', externalId: 'desktop:42' }],
				},
			})
		files['origin-external-refs.jsonl'] = log.text()
	}

	return files
}

/** Rewrites the committed fixture files from {@link buildSessionLogFixtures}. */
export function writeSessionLogFixtures(root: string = HERE): void {
	for (const [name, content] of Object.entries(buildSessionLogFixtures())) {
		const path = join(root, name)
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, content)
	}
}
