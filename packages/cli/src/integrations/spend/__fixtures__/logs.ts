import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Session logs for the spend tests, written the way the kernel's recorder
 * writes the records the spend view reads: `session_started`, `turn_started`,
 * `request_envelope`, `token_usage_updated` (the turn's CUMULATIVE usage and
 * cost), `provider_fallback`, and `turn_completed`/`turn_failed` with the
 * settlement. A `message` record with bulky text sits in every turn, so a
 * reader that parses whole logs would show it in the timings.
 */

export interface FixtureCall {
	readonly at: string
	/** Model that answered; defaults to the turn's. Written as a `request_envelope`. */
	readonly model?: string
	readonly prompt: number
	readonly completion: number
	readonly cacheRead?: number
	readonly cacheWrite?: number
	readonly costUsd: number
	readonly unpriced?: number
	/** `compaction` writes the snapshot a compaction pass writes. */
	readonly kind?: 'reply' | 'compaction'
	/** A route change before this call. */
	readonly fallbackTo?: { providerId: string; model?: string }
}

export interface FixtureTurn {
	readonly startAt: string
	readonly model: string
	readonly calls: readonly FixtureCall[]
	/** When the turn settled; absent leaves the turn open. */
	readonly endAt?: string
	readonly end?: 'completed' | 'failed'
	readonly servingProvider?: string
	/** Spend the settlement holds beyond the last snapshot. */
	readonly tailCostUsd?: number
	readonly tailTokens?: number
	/** Do not write any `token_usage_updated`; the settlement is all the log knows. */
	readonly noSnapshots?: boolean
	/** The turn id of an earlier turn: a resumed turn continues its cumulative. */
	readonly turnId?: string
}

export interface FixtureSession {
	readonly id?: string
	readonly slug?: string
	readonly parentKind?: 'agent_spawn' | 'user_handoff' | 'intervention'
	/** For a sub-agent: the root session it lives under. */
	readonly rootId?: string
	readonly engineId?: string
	readonly cwd?: string
	readonly turns: readonly FixtureTurn[]
}

interface Cum {
	prompt: number
	completion: number
	cacheRead: number
	cacheWrite: number
	cost: number
	unpriced: number
}

const usageOf = (c: Cum) => ({
	promptTokens: c.prompt,
	completionTokens: c.completion,
	totalTokens: c.prompt + c.completion + c.cacheRead + c.cacheWrite,
	cachedTokens: c.cacheRead,
	cacheWriteTokens: c.cacheWrite,
})

const costOf = (c: Cum) => ({
	totalCost: c.cost,
	cacheDiscount: 0,
	unpricedTokens: c.unpriced,
})

export function sessionLogText(session: FixtureSession): { id: string; text: string } {
	const id = session.id ?? randomUUID()
	const lines: string[] = []
	let seq = 0
	const push = (ts: string, record: Record<string, unknown>): void => {
		seq += 1
		lines.push(
			JSON.stringify({
				v: 1,
				id: `rec-${seq}`,
				sessionId: id,
				seq,
				ts,
				prev: null,
				gen: 1,
				...record,
			}),
		)
	}
	const first = session.turns[0]?.startAt ?? '2026-01-01T00:00:00.000Z'
	push(first, {
		type: 'session_started',
		projectId: 'p',
		cwd: session.cwd ?? '/work/project',
		agent: { id: 'a', name: 'agent' },
		...(session.parentKind
			? {
					parent: {
						sessionId: session.rootId ?? randomUUID(),
						turnId: 't',
						toolCallId: 'c',
						rootSessionId: session.rootId ?? randomUUID(),
						depth: 1,
						kind: session.parentKind,
					},
				}
			: {}),
		...(session.engineId
			? {
					harness: {
						v: 1,
						engineId: session.engineId,
						profileRef: 'x',
						nativeSessionId: 'n',
						cwd: '/w',
						initialModel: 'm',
					},
				}
			: {}),
	})
	const carried = new Map<string, Cum>()
	for (const [index, turn] of session.turns.entries()) {
		const turnId = turn.turnId ?? `turn-${index}`
		const cum: Cum = carried.get(turnId) ?? {
			prompt: 0,
			completion: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			unpriced: 0,
		}
		if (!turn.turnId || !carried.has(turnId)) {
			push(turn.startAt, {
				type: 'turn_started',
				turnId,
				userMessageId: 'm',
				config: { model: turn.model, tokenBudget: 1, timeoutMs: 1 },
			})
		} else {
			push(turn.startAt, { type: 'turn_resuming', turnId, fromCheckpointId: 'c' })
		}
		push(turn.startAt, {
			type: 'message',
			turnId,
			messageId: 'm',
			role: 'user',
			content: {
				role: 'user',
				content: `${'x'.repeat(2000)} "type":"turn_started" "type":"token_usage_updated"`,
			},
		})
		let currentModel = turn.model
		for (const call of turn.calls) {
			if (call.fallbackTo) {
				push(call.at, {
					type: 'provider_fallback',
					turnId,
					iteration: 1,
					fromIndex: 0,
					fromProviderId: 'first',
					toIndex: 1,
					toProviderId: call.fallbackTo.providerId,
					...(call.fallbackTo.model ? { toModel: call.fallbackTo.model } : {}),
					code: 'x',
				})
				if (call.fallbackTo.model) currentModel = call.fallbackTo.model
			}
			if (call.model && call.model !== currentModel) {
				push(call.at, { type: 'request_envelope', turnId, iteration: 1, model: call.model })
				currentModel = call.model
			}
			cum.prompt += call.prompt
			cum.completion += call.completion
			cum.cacheRead += call.cacheRead ?? 0
			cum.cacheWrite += call.cacheWrite ?? 0
			cum.cost += call.costUsd
			cum.unpriced += call.unpriced ?? 0
			if (!turn.noSnapshots) {
				push(call.at, {
					type: 'token_usage_updated',
					turnId,
					usage: usageOf(cum),
					cost: costOf(cum),
					...(call.kind === 'compaction' ? { contextMeasuredBy: 'estimate' } : {}),
				})
			}
		}
		carried.set(turnId, cum)
		if (turn.endAt !== undefined) {
			const end: Cum = {
				...cum,
				cost: cum.cost + (turn.tailCostUsd ?? 0),
				completion: cum.completion + (turn.tailTokens ?? 0),
			}
			const settlement = {
				status: turn.end === 'failed' ? 'failed' : 'completed',
				iterations: 1,
				usage: usageOf(end),
				cost: costOf(end),
				durationMs: 1,
				resultSource: 'model',
				...(turn.servingProvider ? { servingProvider: turn.servingProvider } : {}),
				abandonedTaskIds: [],
				abandonedJobIds: [],
			}
			push(
				turn.endAt,
				turn.end === 'failed'
					? { type: 'turn_failed', turnId, error: 'x', settlement }
					: { type: 'turn_completed', turnId, result: 'ok', settlement },
			)
			carried.delete(turnId)
			cum.cost = end.cost
		}
	}
	return { id, text: `${lines.join('\n')}\n` }
}

/** Write a session under `<home>/projects/<slug>/` (or `<root>/subagents/` for a sub-agent). */
export function writeSession(home: string, session: FixtureSession): { id: string; path: string } {
	const { id, text } = sessionLogText(session)
	const slug = session.slug ?? '-work-project'
	const path = session.rootId
		? join(home, 'projects', slug, session.rootId, 'subagents', `${id}.jsonl`)
		: join(home, 'projects', slug, `${id}.jsonl`)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, text)
	return { id, path }
}
