import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { buildCostReport, parseCostArgs } from '../../commands/cost.js'
import { type FixtureSession, sessionLogText, writeSession } from './__fixtures__/logs.js'
import { type SpendClock, createDayKeyer, shiftDay, slotOf } from './day.js'
import { ModelTable, foldWholeLog } from './fold.js'
import { SPEND_LEDGER_FILE, SPEND_LEDGER_VERSION, discoverLogs, refreshLedger } from './ledger.js'
import { renderSpend } from './render.js'
import { buildSpendReport, conversationTotals } from './report.js'

let home: string
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-spend-'))
})
afterEach(() => removeTempDir(home))

const clockAt = (iso: string, timeZone = 'UTC'): SpendClock => ({
	nowMs: () => Date.parse(iso),
	timeZone,
})

const WIDE = 3660

/** The settled costs written in the raw files: what a person adding up `turn_completed` would get. */
function rawSettledCost(files: readonly string[]): number {
	let sum = 0
	for (const file of files) {
		for (const line of readFileSync(file, 'utf8').split('\n')) {
			if (!line.includes('"type":"turn_completed"') && !line.includes('"type":"turn_failed"'))
				continue
			const record = JSON.parse(line) as { settlement?: { cost: { totalCost: number } } }
			if (record.settlement) sum += record.settlement.cost.totalCost
		}
	}
	return sum
}

describe('folding one log', () => {
	it('splits a turn into the differences of its cumulative figures and they add up to the settlement', () => {
		const { text } = sessionLogText({
			turns: [
				{
					startAt: '2026-11-10T10:00:00.000Z',
					model: 'm1',
					calls: [
						{ at: '2026-11-10T10:00:05.000Z', prompt: 100, completion: 10, costUsd: 0.5 },
						{
							at: '2026-11-10T10:00:09.000Z',
							prompt: 200,
							completion: 20,
							cacheRead: 50,
							costUsd: 0.25,
						},
					],
					endAt: '2026-11-10T10:00:12.000Z',
					tailCostUsd: 0.125,
					tailTokens: 5,
				},
			],
		})
		const result = foldWholeLog(text)
		const cost = result.rows.reduce((sum, row) => sum + row[9], 0)
		expect(cost).toBeCloseTo(0.875, 12)
		expect(result.settled.length).toBeGreaterThan(0)
		expect(result.open).toEqual([])
		// the tail is the one internal row
		expect(result.rows.filter((row) => row[1] === 2).map((row) => row[9])).toEqual([0.125])
	})

	it('names compaction by the snapshot it writes and attributes models and routes after a fallback', () => {
		const models = new ModelTable()
		const { text } = sessionLogText({
			turns: [
				{
					startAt: '2026-11-10T10:00:00.000Z',
					model: 'big',
					servingProvider: 'second',
					calls: [
						{ at: '2026-11-10T10:00:05.000Z', prompt: 100, completion: 10, costUsd: 1 },
						{
							at: '2026-11-10T10:00:08.000Z',
							prompt: 30,
							completion: 3,
							costUsd: 0.1,
							kind: 'compaction',
						},
						{
							at: '2026-11-10T10:00:12.000Z',
							prompt: 50,
							completion: 5,
							costUsd: 0.2,
							fallbackTo: { providerId: 'second', model: 'small' },
						},
					],
					endAt: '2026-11-10T10:00:20.000Z',
				},
			],
		})
		const result = foldWholeLog(text, models)
		const byKind = (kind: number) =>
			result.rows.filter((row) => row[1] === kind).reduce((s, r) => s + r[9], 0)
		expect(byKind(0)).toBeCloseTo(1.2, 12)
		expect(byKind(1)).toBeCloseTo(0.1, 12)
		const used = result.rows.map((row) => models.list[row[2]])
		expect(used).toContainEqual({ provider: 'first', model: 'big' })
		expect(used).toContainEqual({ provider: 'second', model: 'small' })
	})

	it('counts an open turn up to its last snapshot and resumes the next read at its start', () => {
		const { text } = sessionLogText({
			turns: [
				{
					startAt: '2026-11-10T10:00:00.000Z',
					model: 'm',
					calls: [{ at: '2026-11-10T10:00:05.000Z', prompt: 10, completion: 1, costUsd: 0.3 }],
					endAt: '2026-11-10T10:01:00.000Z',
				},
				{
					startAt: '2026-11-10T11:00:00.000Z',
					model: 'm',
					calls: [{ at: '2026-11-10T11:00:05.000Z', prompt: 10, completion: 1, costUsd: 0.7 }],
				},
			],
		})
		const result = foldWholeLog(text)
		expect(result.settled.reduce((s, r) => s + r[9], 0)).toBeCloseTo(0.3, 12)
		expect(result.open.reduce((s, r) => s + r[9], 0)).toBeCloseTo(0.7, 12)
		const secondTurnStart = text.indexOf('{"v":1,"id":"rec-', text.indexOf('"turn-1"') - 200)
		expect(result.from).toBeLessThanOrEqual(text.indexOf('"turn-1"'))
		expect(result.from).toBeGreaterThan(secondTurnStart - 400)
	})

	it('leaves a line still being written alone', () => {
		const { text } = sessionLogText({
			turns: [
				{
					startAt: '2026-11-10T10:00:00.000Z',
					model: 'm',
					calls: [{ at: '2026-11-10T10:00:05.000Z', prompt: 10, completion: 1, costUsd: 0.3 }],
					endAt: '2026-11-10T10:01:00.000Z',
				},
			],
		})
		const torn = text.slice(0, text.length - 40)
		const result = foldWholeLog(torn)
		// the settlement line is incomplete: the turn is open, with its snapshot counted
		expect(result.open.reduce((s, r) => s + r[9], 0)).toBeCloseTo(0.3, 12)
		expect(result.settled).toEqual([])
	})

	it('separates fresh input from cache reads only where the route has a rate card', () => {
		const calls = [
			{
				at: '2026-11-10T10:00:05.000Z',
				prompt: 1000,
				completion: 10,
				cacheRead: 600,
				costUsd: 0.5,
			},
		]
		const base = { startAt: '2026-11-10T10:00:00.000Z', model: 'claude-opus-5-5', calls }
		// `anthropic` counts the prompt without its cache reads; `openai` counts them inside it.
		const anthropic = foldWholeLog(
			sessionLogText({
				turns: [{ ...base, endAt: '2026-11-10T10:00:09.000Z', servingProvider: 'anthropic' }],
			}).text,
		)
		expect(anthropic.rows.reduce((s, r) => s + r[4], 0)).toBe(1000)
		const openai = foldWholeLog(
			sessionLogText({
				turns: [
					{ ...base, model: 'gpt-5', endAt: '2026-11-10T10:00:09.000Z', servingProvider: 'openai' },
				],
			}).text,
		)
		expect(
			openai.rows.reduce((s, r) => s + r[4], 0) + openai.rows.reduce((s, r) => s + r[5], 0),
		).toBeGreaterThan(0)
		const unknown = foldWholeLog(
			sessionLogText({
				turns: [{ ...base, endAt: '2026-11-10T10:00:09.000Z', servingProvider: 'mystery' }],
			}).text,
		)
		expect(unknown.rows.reduce((s, r) => s + r[4], 0)).toBe(0)
		expect(unknown.rows.reduce((s, r) => s + r[5], 0)).toBe(1000)
	})
})

/** The fixture set the reconciliation tests share: each case the brief names. */
function writeReconciliationSet(): {
	files: string[]
	expectedCost: number
	expectedTokens: number
} {
	const sessions: FixtureSession[] = [
		// crosses midnight (UTC): calls on both sides of it
		{
			turns: [
				{
					startAt: '2026-11-09T23:40:00.000Z',
					model: 'claude-opus-5-5',
					servingProvider: 'anthropic',
					calls: [
						{ at: '2026-11-09T23:50:00.000Z', prompt: 1000, completion: 100, costUsd: 1.5 },
						{ at: '2026-11-10T00:10:00.000Z', prompt: 2000, completion: 200, costUsd: 2.5 },
					],
					endAt: '2026-11-10T00:11:00.000Z',
				},
			],
		},
		// two models in one turn
		{
			turns: [
				{
					startAt: '2026-11-10T09:00:00.000Z',
					model: 'claude-opus-5-5',
					servingProvider: 'anthropic',
					calls: [
						{ at: '2026-11-10T09:01:00.000Z', prompt: 500, completion: 50, costUsd: 0.75 },
						{
							at: '2026-11-10T09:02:00.000Z',
							model: 'claude-sonnet-5-5',
							prompt: 800,
							completion: 80,
							costUsd: 0.125,
						},
					],
					endAt: '2026-11-10T09:03:00.000Z',
				},
			],
		},
		// compacted
		{
			turns: [
				{
					startAt: '2026-11-10T12:00:00.000Z',
					model: 'claude-opus-5-5',
					servingProvider: 'anthropic',
					calls: [
						{ at: '2026-11-10T12:01:00.000Z', prompt: 3000, completion: 300, costUsd: 3.25 },
						{
							at: '2026-11-10T12:02:00.000Z',
							prompt: 400,
							completion: 40,
							costUsd: 0.375,
							kind: 'compaction',
						},
					],
					endAt: '2026-11-10T12:03:00.000Z',
					tailCostUsd: 0.0625,
					tailTokens: 6,
				},
			],
		},
		// resumed on another day: one turn paused on day 1, finished on day 2
		{
			turns: [
				{
					turnId: 'turn-resumed',
					startAt: '2026-11-08T15:00:00.000Z',
					model: 'claude-opus-5-5',
					servingProvider: 'anthropic',
					calls: [{ at: '2026-11-08T15:01:00.000Z', prompt: 100, completion: 10, costUsd: 0.5 }],
				},
				{
					turnId: 'turn-resumed',
					startAt: '2026-11-11T08:00:00.000Z',
					model: 'claude-opus-5-5',
					servingProvider: 'anthropic',
					calls: [{ at: '2026-11-11T08:01:00.000Z', prompt: 100, completion: 10, costUsd: 0.25 }],
					endAt: '2026-11-11T08:02:00.000Z',
				},
			],
		},
		// a failed turn and an unpriced model
		{
			turns: [
				{
					startAt: '2026-11-11T10:00:00.000Z',
					model: 'mystery-model',
					servingProvider: 'nowhere',
					calls: [
						{
							at: '2026-11-11T10:01:00.000Z',
							prompt: 700,
							completion: 70,
							costUsd: 0,
							unpriced: 770,
						},
					],
					endAt: '2026-11-11T10:02:00.000Z',
					end: 'failed',
				},
			],
		},
	]
	const files: string[] = []
	for (const session of sessions) files.push(writeSession(home, session).path)
	// sub-agents of the first session, one of each kind of child
	const root = files[0] as string
	const rootId = root.slice(root.lastIndexOf('/') + 1, -'.jsonl'.length)
	for (const kind of ['agent_spawn', 'user_handoff'] as const) {
		files.push(
			writeSession(home, {
				rootId,
				parentKind: kind,
				turns: [
					{
						startAt: '2026-11-10T01:00:00.000Z',
						model: 'claude-sonnet-5-5',
						servingProvider: 'anthropic',
						calls: [
							{ at: '2026-11-10T01:01:00.000Z', prompt: 100, completion: 10, costUsd: 0.0625 },
						],
						endAt: '2026-11-10T01:02:00.000Z',
					},
				],
			}).path,
		)
	}
	// 1.5+2.5 + 0.75+0.125 + 3.25+0.375+0.0625 + 0.5+0.25 + 0 + 2*0.0625
	return { files, expectedCost: 9.4375, expectedTokens: 0 }
}

describe('the view reconciles with what each conversation shows', () => {
	it('adds up to the sum of the per-conversation costs, to the raw settlements, and to the hand-added figure', async () => {
		const { files, expectedCost } = writeReconciliationSet()
		const { ledger } = await refreshLedger({ home })
		const report = buildSpendReport({
			ledger,
			clock: clockAt('2026-11-12T12:00:00.000Z'),
			days: WIDE,
		})

		const perConversation = [...ledger.sessions.values()].map(conversationTotals)
		const summed = perConversation.reduce((s, t) => s + t.estimatedCostUsd, 0)
		const summedTokens = perConversation.reduce((s, t) => s + t.tokens, 0)

		expect(report.totals.conversations).toBe(files.length)
		expect(report.totals.estimatedCostUsd).toBeCloseTo(summed, 9)
		expect(report.totals.tokens).toBe(summedTokens)
		expect(report.totals.estimatedCostUsd).toBeCloseTo(rawSettledCost(files), 9)
		expect(report.totals.estimatedCostUsd).toBeCloseTo(expectedCost, 9)
		// every cut is the same total
		for (const cut of [report.days, report.models, report.projects, report.kinds]) {
			expect(cut.reduce((s, row) => s + row.estimatedCostUsd, 0)).toBeCloseTo(summed, 9)
			expect(cut.reduce((s, row) => s + row.tokens, 0)).toBe(summedTokens)
		}
	})

	it('puts a conversation that crosses midnight on both days, and a resumed one on the days it ran', async () => {
		writeReconciliationSet()
		const { ledger } = await refreshLedger({ home })
		const report = buildSpendReport({
			ledger,
			clock: clockAt('2026-11-12T12:00:00.000Z'),
			days: WIDE,
		})
		const day = (date: string) => report.days.find((d) => d.date === date)
		// 11-09: 1.5 from the midnight crosser; 11-10: 2.5 + 0.875 + 3.25+0.375+0.0625 + 0.125 (children)
		expect(day('2026-11-09')?.estimatedCostUsd).toBeCloseTo(1.5, 9)
		expect(day('2026-11-10')?.estimatedCostUsd).toBeCloseTo(2.5 + 0.875 + 3.6875 + 0.125, 9)
		// resumed: 0.5 on the 8th, 0.25 on the 11th
		expect(day('2026-11-08')?.estimatedCostUsd).toBeCloseTo(0.5, 9)
		expect(day('2026-11-11')?.estimatedCostUsd).toBeCloseTo(0.25, 9)
	})

	it('shows two models of one turn apart, and sub-agents and compaction as their own kinds', async () => {
		writeReconciliationSet()
		const { ledger } = await refreshLedger({ home })
		const report = buildSpendReport({
			ledger,
			clock: clockAt('2026-11-12T12:00:00.000Z'),
			days: WIDE,
		})
		const sonnet = report.models.find((m) => m.model === 'claude-sonnet-5-5')
		expect(sonnet?.estimatedCostUsd).toBeCloseTo(0.125 + 0.125, 9)
		const kinds = Object.fromEntries(report.kinds.map((k) => [k.kind, k.estimatedCostUsd]))
		expect(kinds.subagents).toBeCloseTo(0.125, 9)
		expect(kinds.compaction).toBeCloseTo(0.375, 9)
		expect(kinds.internal).toBeCloseTo(0.0625, 9)
		expect(kinds.replies).toBeCloseTo(9.4375 - 0.125 - 0.375 - 0.0625, 9)
	})

	it('shows an unpriced model as tokens and "price not known", and says the total is partial', async () => {
		writeReconciliationSet()
		const { ledger } = await refreshLedger({ home })
		const report = buildSpendReport({
			ledger,
			clock: clockAt('2026-11-12T12:00:00.000Z'),
			days: WIDE,
		})
		const mystery = report.models.find((m) => m.model === 'mystery-model')
		expect(mystery).toMatchObject({ tokens: 770, unpricedTokens: 770, priceKnown: false })
		expect(mystery?.estimatedCostUsd).toBe(0)
		expect(report.totals.partial).toBe(true)
		expect(report.totals.unpricedModels).toEqual(['mystery-model (nowhere)'])
		const text = renderSpend(report)
		expect(text).toMatch(/mystery-model \(nowhere\).*price not known/)
		expect(text).toContain('This total is partial')
		expect(text).toContain('Missing a price: mystery-model (nowhere)')
		expect(text).toContain('estimate from list prices')
		// a priced total beside an unpriced part is a floor, never a plain amount
		expect(text).toMatch(/Total: .*at least \$9\.44/)
	})

	it('calls a route local only when the catalogue says it bills nothing per token', async () => {
		writeSession(home, {
			turns: [
				{
					startAt: '2026-11-10T10:00:00.000Z',
					model: 'llama',
					servingProvider: 'ollama',
					calls: [{ at: '2026-11-10T10:00:05.000Z', prompt: 10, completion: 1, costUsd: 0 }],
					endAt: '2026-11-10T10:00:09.000Z',
				},
			],
		})
		writeSession(home, {
			turns: [
				{
					startAt: '2026-11-10T10:00:00.000Z',
					model: 'some-free-model',
					servingProvider: 'zen',
					calls: [
						{ at: '2026-11-10T10:00:05.000Z', prompt: 10, completion: 1, costUsd: 0, unpriced: 11 },
					],
					endAt: '2026-11-10T10:00:09.000Z',
				},
			],
		})
		const { ledger } = await refreshLedger({ home })
		const report = buildSpendReport({
			ledger,
			clock: clockAt('2026-11-12T00:00:00.000Z'),
			days: 30,
		})
		expect(report.models.find((m) => m.model === 'llama')).toMatchObject({
			billing: 'local',
			priceKnown: true,
		})
		expect(report.models.find((m) => m.model === 'some-free-model')).toMatchObject({
			billing: 'per-token',
			priceKnown: false,
		})
		const text = renderSpend(report)
		expect(text).toMatch(/llama \(ollama\).*not billed \(local\)/)
		expect(text).toMatch(/some-free-model \(zen\).*price not known/)
		expect(text).toContain('Which subscription or free quota paid for a call is not recorded')
	})

	it('counts conversations run through an outside engine and says billing is not recorded', async () => {
		writeSession(home, {
			engineId: 'outside',
			turns: [
				{
					startAt: '2026-11-10T10:00:00.000Z',
					model: 'm',
					calls: [
						{ at: '2026-11-10T10:00:05.000Z', prompt: 10, completion: 1, costUsd: 0, unpriced: 11 },
					],
					endAt: '2026-11-10T10:00:09.000Z',
				},
			],
		})
		const { ledger } = await refreshLedger({ home })
		const report = buildSpendReport({ ledger, clock: clockAt('2026-11-12T00:00:00.000Z') })
		expect(report.notes.join('\n')).toContain('ran through an outside engine')
	})

	it('has a stable JSON shape', async () => {
		writeReconciliationSet()
		const report = await buildCostReport(WIDE, { home, clock: clockAt('2026-11-12T12:00:00.000Z') })
		const json = JSON.parse(JSON.stringify(report)) as Record<string, unknown>
		expect(Object.keys(json)).toEqual([
			'schemaVersion',
			'kind',
			'estimate',
			'currency',
			'window',
			'totals',
			'days',
			'models',
			'projects',
			'kinds',
			'topConversations',
			'notes',
		])
		expect(json.schemaVersion).toBe(1)
		expect(json.estimate).toBe(true)
		expect(Object.keys((json.totals as object) ?? {}).sort()).toEqual(
			[
				'cacheReadTokens',
				'cacheWriteTokens',
				'conversations',
				'estimatedCostUsd',
				'freshInputTokens',
				'outputTokens',
				'partial',
				'tokens',
				'unpricedModels',
				'unpricedTokens',
				'unsplitInputTokens',
			].sort(),
		)
		expect(Object.keys((report.days[0] as object) ?? {})).toContain('models')
		expect(Object.keys((report.models[0] as object) ?? {}).sort()).toEqual(
			[
				'billing',
				'cacheReadTokens',
				'cacheWriteTokens',
				'estimatedCostUsd',
				'freshInputTokens',
				'model',
				'outputTokens',
				'priceKnown',
				'provider',
				'tokens',
				'unpricedTokens',
				'unsplitInputTokens',
			].sort(),
		)
	})

	it('limits the window to the last N local days', async () => {
		writeReconciliationSet()
		const { ledger } = await refreshLedger({ home })
		const report = buildSpendReport({ ledger, clock: clockAt('2026-11-12T12:00:00.000Z'), days: 2 })
		expect(report.window).toMatchObject({ days: 2, from: '2026-11-11', to: '2026-11-12' })
		expect(report.days.map((d) => d.date)).toEqual(['2026-11-11'])
		expect(report.totals.estimatedCostUsd).toBeCloseTo(0.25, 9)
	})

	it('reports an empty window plainly', async () => {
		const { ledger } = await refreshLedger({ home })
		const text = renderSpend(
			buildSpendReport({ ledger, clock: clockAt('2026-11-12T00:00:00.000Z') }),
		)
		expect(text).toContain('No usage was recorded in this window.')
	})
})

describe('local days', () => {
	it('puts a spring-forward day (23 hours) and a fall-back day (25 hours) each on one date', () => {
		const ny = createDayKeyer('America/New_York')
		// 2026-03-08: clocks jump 02:00 -> 03:00 EST->EDT at 07:00Z
		expect(ny(Date.parse('2026-03-08T04:59:00Z'))).toBe('2026-03-07')
		expect(ny(Date.parse('2026-03-08T05:00:00Z'))).toBe('2026-03-08')
		expect(ny(Date.parse('2026-03-09T03:59:00Z'))).toBe('2026-03-08')
		expect(ny(Date.parse('2026-03-09T04:00:00Z'))).toBe('2026-03-09')
		// 2026-11-01: the 01:00 hour happens twice
		expect(ny(Date.parse('2026-11-01T03:59:00Z'))).toBe('2026-10-31')
		expect(ny(Date.parse('2026-11-01T05:30:00Z'))).toBe('2026-11-01')
		expect(ny(Date.parse('2026-11-01T06:30:00Z'))).toBe('2026-11-01')
		expect(ny(Date.parse('2026-11-02T04:59:00Z'))).toBe('2026-11-01')
		expect(ny(Date.parse('2026-11-02T05:00:00Z'))).toBe('2026-11-02')
	})

	it('sums a 25 hour day into one day in both directions and counts calendar days for the window', async () => {
		const at = (iso: string, cost: number) => ({
			at: iso,
			prompt: 10,
			completion: 1,
			costUsd: cost,
		})
		writeSession(home, {
			turns: [
				{
					startAt: '2026-11-01T04:00:00.000Z',
					model: 'm',
					servingProvider: 'anthropic',
					calls: [
						at('2026-11-01T04:30:00.000Z', 1), // 00:30 EDT, Nov 1
						at('2026-11-01T06:30:00.000Z', 2), // 01:30 EST (second 01:00 hour), Nov 1
						at('2026-11-02T04:59:00.000Z', 4), // 23:59 EST, Nov 1
						at('2026-11-02T05:00:00.000Z', 8), // 00:00 EST, Nov 2
					],
					endAt: '2026-11-02T05:01:00.000Z',
				},
			],
		})
		const { ledger } = await refreshLedger({ home })
		const report = buildSpendReport({
			ledger,
			clock: clockAt('2026-11-02T18:00:00.000Z', 'America/New_York'),
			days: 3,
		})
		expect(report.window).toMatchObject({ from: '2026-10-31', to: '2026-11-02' })
		expect(report.days.map((d) => [d.date, d.estimatedCostUsd])).toEqual([
			['2026-11-01', 7],
			['2026-11-02', 8],
		])
		// spring forward: a 23 hour day
		expect(shiftDay('2026-03-09', 1)).toBe('2026-03-08')
		expect(shiftDay('2026-03-09', 2)).toBe('2026-03-07')
		expect(shiftDay('2026-03-01', 1)).toBe('2026-02-28')
	})

	it('handles a zone far from UTC and zones whose offset is not a whole hour', () => {
		const instant = Date.parse('2026-11-10T10:30:00Z')
		// +14:00: already the 11th
		expect(createDayKeyer('Pacific/Kiritimati')(instant)).toBe('2026-11-11')
		// -11:00: still the 10th; the 9th just before 11:00Z
		expect(createDayKeyer('Pacific/Pago_Pago')(Date.parse('2026-11-10T10:59:00Z'))).toBe(
			'2026-11-09',
		)
		expect(createDayKeyer('Pacific/Pago_Pago')(Date.parse('2026-11-10T11:00:00Z'))).toBe(
			'2026-11-10',
		)
		// +05:45: midnight local is 18:15Z
		const nepal = createDayKeyer('Asia/Kathmandu')
		expect(nepal(Date.parse('2026-11-10T18:14:00Z'))).toBe('2026-11-10')
		expect(nepal(Date.parse('2026-11-10T18:15:00Z'))).toBe('2026-11-11')
		// Lord Howe moves by 30 minutes: +11:00 in summer, +10:30 in winter
		const howe = createDayKeyer('Australia/Lord_Howe')
		expect(howe(Date.parse('2026-01-14T12:59:00Z'))).toBe('2026-01-14')
		expect(howe(Date.parse('2026-01-14T13:00:00Z'))).toBe('2026-01-15')
		expect(howe(Date.parse('2026-07-14T13:29:00Z'))).toBe('2026-07-14')
		expect(howe(Date.parse('2026-07-14T13:30:00Z'))).toBe('2026-07-15')
	})

	it('puts the same recorded spend on different days in different zones, from the injected clock', async () => {
		writeSession(home, {
			turns: [
				{
					startAt: '2026-11-10T10:00:00.000Z',
					model: 'm',
					servingProvider: 'anthropic',
					calls: [{ at: '2026-11-10T10:30:00.000Z', prompt: 10, completion: 1, costUsd: 1 }],
					endAt: '2026-11-10T10:31:00.000Z',
				},
			],
		})
		const { ledger } = await refreshLedger({ home })
		const inZone = (zone: string) =>
			buildSpendReport({
				ledger,
				clock: clockAt('2026-11-12T00:00:00.000Z', zone),
				days: 5,
			}).days.map((d) => d.date)
		expect(inZone('Pacific/Kiritimati')).toEqual(['2026-11-11'])
		expect(inZone('Pacific/Pago_Pago')).toEqual(['2026-11-09'])
		expect(inZone('UTC')).toEqual(['2026-11-10'])
		expect(slotOf(0)).toBe(0)
	})
})

describe('the ledger', () => {
	it('reads each log once, then nothing while nothing changed, then only what was appended', async () => {
		const { path } = writeSession(home, {
			turns: [
				{
					startAt: '2026-11-10T10:00:00.000Z',
					model: 'm',
					servingProvider: 'anthropic',
					calls: [{ at: '2026-11-10T10:00:05.000Z', prompt: 10, completion: 1, costUsd: 1 }],
					endAt: '2026-11-10T10:01:00.000Z',
				},
			],
		})
		const first = await refreshLedger({ home })
		expect(first.stats).toMatchObject({ logs: 1, read: 1, wrote: true, rebuilt: true })
		const size = statSync(path).size
		expect(first.stats.bytesRead).toBe(size)

		const second = await refreshLedger({ home })
		expect(second.stats).toMatchObject({ read: 0, bytesRead: 0, wrote: false, rebuilt: false })

		// a later turn, appended
		const more = sessionLogText({
			id: 'ignored',
			turns: [
				{
					startAt: '2026-11-11T10:00:00.000Z',
					model: 'm',
					servingProvider: 'anthropic',
					calls: [{ at: '2026-11-11T10:00:05.000Z', prompt: 10, completion: 1, costUsd: 2 }],
					endAt: '2026-11-11T10:01:00.000Z',
				},
			],
		}).text
		const appended = more.split('\n').slice(1).join('\n') // without a second session_started
		appendFileSync(path, appended)
		const third = await refreshLedger({ home })
		expect(third.stats.read).toBe(1)
		expect(third.stats.bytesRead).toBe(Buffer.byteLength(appended))
		expect(third.stats.bytesRead).toBeLessThan(statSync(path).size)
		const totals = [...third.ledger.sessions.values()].map(conversationTotals)
		expect(totals[0]?.estimatedCostUsd).toBeCloseTo(3, 12)
	})

	it('reads an open turn again from its start, and counts it once when it settles', async () => {
		const open = {
			startAt: '2026-11-10T10:00:00.000Z',
			model: 'm',
			servingProvider: 'anthropic',
			calls: [{ at: '2026-11-10T10:00:05.000Z', prompt: 10, completion: 1, costUsd: 1 }],
		}
		const { path, id } = writeSession(home, { turns: [open] })
		const a = await refreshLedger({ home })
		expect([...a.ledger.sessions.values()].map(conversationTotals)[0]?.estimatedCostUsd).toBe(1)
		// the same turn settles with a second call
		const settled = sessionLogText({
			id,
			turns: [
				{
					...open,
					calls: [
						...open.calls,
						{ at: '2026-11-10T10:00:09.000Z', prompt: 10, completion: 1, costUsd: 2 },
					],
					endAt: '2026-11-10T10:01:00.000Z',
				},
			],
		}).text
		writeFileSync(path, settled)
		const b = await refreshLedger({ home })
		expect([...b.ledger.sessions.values()].map(conversationTotals)[0]?.estimatedCostUsd).toBe(3)
	})

	it('can be deleted, or be of another version, and is then rebuilt to the same answer', async () => {
		writeReconciliationSet()
		const before = buildSpendReport({
			ledger: (await refreshLedger({ home })).ledger,
			clock: clockAt('2026-11-12T00:00:00.000Z'),
			days: WIDE,
		})
		const file = join(home, SPEND_LEDGER_FILE)
		const stamped = JSON.parse(readFileSync(file, 'utf8')) as { version: number }
		expect(stamped.version).toBe(SPEND_LEDGER_VERSION)

		writeFileSync(file, JSON.stringify({ ...stamped, version: SPEND_LEDGER_VERSION + 1 }))
		const wrongVersion = await refreshLedger({ home })
		expect(wrongVersion.stats.rebuilt).toBe(true)
		writeFileSync(file, '{ not json')
		const garbled = await refreshLedger({ home })
		expect(garbled.stats.rebuilt).toBe(true)
		const after = buildSpendReport({
			ledger: garbled.ledger,
			clock: clockAt('2026-11-12T00:00:00.000Z'),
			days: WIDE,
		})
		expect(after).toEqual(before)
		expect((JSON.parse(readFileSync(file, 'utf8')) as { version: number }).version).toBe(
			SPEND_LEDGER_VERSION,
		)
	})

	it('reads a log that shrank from the start, and forgets a log that is gone', async () => {
		const a = writeSession(home, {
			turns: [
				{
					startAt: '2026-11-10T10:00:00.000Z',
					model: 'm',
					calls: [{ at: '2026-11-10T10:00:05.000Z', prompt: 10, completion: 1, costUsd: 1 }],
					endAt: '2026-11-10T10:01:00.000Z',
				},
			],
		})
		const b = writeSession(home, {
			turns: [
				{
					startAt: '2026-11-10T10:00:00.000Z',
					model: 'm',
					calls: [{ at: '2026-11-10T10:00:05.000Z', prompt: 10, completion: 1, costUsd: 5 }],
					endAt: '2026-11-10T10:01:00.000Z',
				},
			],
		})
		await refreshLedger({ home })
		const shrunk = sessionLogText({
			id: a.id,
			turns: [
				{
					startAt: '2026-11-10T10:00:00.000Z',
					model: 'm',
					calls: [{ at: '2026-11-10T10:00:05.000Z', prompt: 1, completion: 1, costUsd: 0.5 }],
					endAt: '2026-11-10T10:01:00.000Z',
				},
			],
		}).text
		// cut after the first three records: much shorter than what was read
		writeFileSync(a.path, `${shrunk.split('\n').slice(0, 3).join('\n')}\n`)
		const { rmSync } = await import('node:fs')
		rmSync(b.path)
		const refreshed = await refreshLedger({ home })
		expect(refreshed.stats.logs).toBe(1)
		expect(refreshed.ledger.sessions.size).toBe(1)
	})

	it('finds sub-agent logs at any depth and ignores files that are not session logs', async () => {
		const root = writeSession(home, { turns: [] })
		const child = writeSession(home, { rootId: root.id, parentKind: 'agent_spawn', turns: [] })
		const grandchild = writeSession(home, {
			rootId: child.id,
			parentKind: 'agent_spawn',
			turns: [],
		})
		// a grandchild lives under <root>/subagents/<child>/subagents/
		mkdirSync(
			join(home, 'projects', '-work-project', root.id, 'subagents', child.id, 'subagents'),
			{
				recursive: true,
			},
		)
		writeFileSync(join(home, 'projects', '-work-project', 'notes.jsonl'), '{}\n')
		writeFileSync(
			join(home, 'projects', '-work-project', root.id, 'subagents', `${child.id}.meta.json`),
			'{}',
		)
		const logs = await discoverLogs(home)
		expect(logs.some((l) => l.endsWith(`${root.id}.jsonl`))).toBe(true)
		expect(logs.some((l) => l.endsWith(`${child.id}.jsonl`))).toBe(true)
		expect(logs.some((l) => l.endsWith('notes.jsonl'))).toBe(false)
		expect(grandchild.path).toContain(child.id)
	})
})

describe('namzu cost arguments', () => {
	it('takes --days and --json, and nothing else', () => {
		expect(parseCostArgs([])).toEqual({ days: 30, json: false })
		expect(parseCostArgs(['--days', '7', '--json'])).toEqual({ days: 7, json: true })
		expect(parseCostArgs(['--days=90'])).toEqual({ days: 90, json: false })
		expect(parseCostArgs(['--days'])).toBeUndefined()
		expect(parseCostArgs(['--days', '0'])).toBeUndefined()
		expect(parseCostArgs(['--days', '9999'])).toBeUndefined()
		expect(parseCostArgs(['--days', 'x'])).toBeUndefined()
		expect(parseCostArgs(['--wat'])).toBeUndefined()
	})
})
