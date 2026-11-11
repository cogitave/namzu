import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { applyEvent, emptyThread } from '../shared/projection.js'
import { applyClosedTabEvent } from './closed-tab.js'
import { ContextReadout, ContextRing } from './context-ring-view.js'
import {
	COMPACTING_TEXT,
	compactedText,
	contextRingModel,
	formatCost,
	formatCostShort,
	formatTokens,
	piePath,
} from './context-ring.js'
import { livePhaseLabel, liveStatus } from './transcript-motion.js'

it('writes token counts in plain words', () => {
	expect([0, 950, 1000, 12_400, 99_999, 200_000, 1_000_000, 1_250_000].map(formatTokens)).toEqual([
		'0',
		'950',
		'1k',
		'12.4k',
		'100k',
		'200k',
		'1M',
		'1.25M',
	])
	expect(formatCost(0.4213)).toBe('$0.42')
	expect(formatCost(0.002)).toBe('under $0.01')
})

it('hides the ring unless the engine gave both a context size and a window', () => {
	expect(contextRingModel(undefined)).toBeUndefined()
	expect(contextRingModel({})).toBeUndefined()
	expect(contextRingModel({ contextTokens: 5000 })).toBeUndefined()
	expect(contextRingModel({ contextWindowTokens: 200_000 })).toBeUndefined()
	expect(contextRingModel({ contextTokens: 5000, contextWindowTokens: 0 })).toBeUndefined()
	expect(renderToStaticMarkup(createElement(ContextRing, { usage: undefined }))).toBe('')
	expect(renderToStaticMarkup(createElement(ContextRing, { usage: { contextTokens: 10 } }))).toBe(
		'',
	)
})

it('says used of window, a share, and the cost only when the engine priced it', () => {
	const model = contextRingModel({
		contextTokens: 12_400,
		contextWindowTokens: 200_000,
		measuredBy: 'provider',
		cost: 0.42,
	})
	expect(model).toMatchObject({ percent: 6, tone: 'normal' })
	expect(model?.lines).toEqual(['Context: 12.4k of 200k tokens (6%)', 'Cost so far: $0.42'])
	expect(model?.label).toBe('Context 6% full. 12.4k of 200k tokens. Cost so far $0.42.')
	const unpriced = contextRingModel({
		contextTokens: 12_400,
		contextWindowTokens: 200_000,
		measuredBy: 'estimate',
	})
	expect(unpriced?.lines).toEqual(['Context: 12.4k of 200k tokens (6%), estimated'])
	expect(unpriced?.label).not.toContain('Cost')
})

it('warns near the limit and never draws past the ring', () => {
	expect(contextRingModel({ contextTokens: 150_000, contextWindowTokens: 200_000 })?.tone).toBe(
		'high',
	)
	const full = contextRingModel({ contextTokens: 190_000, contextWindowTokens: 200_000 })
	expect(full?.tone).toBe('full')
	expect(full?.lines).toContain('Older messages may be summarised to make room.')
	expect(contextRingModel({ contextTokens: 300_000, contextWindowTokens: 200_000 })?.fraction).toBe(
		1,
	)
})

it('draws a labelled, focusable ring with the share filled', () => {
	const html = renderToStaticMarkup(
		createElement(ContextRing, { usage: { contextTokens: 100_000, contextWindowTokens: 200_000 } }),
	)
	expect(html).toContain('class="context-ring"')
	expect(html).toContain('aria-label="Context 50% full. 100k of 200k tokens."')
	expect(html).toContain('data-context-ring="normal"')
	expect(html).toContain('aria-hidden="true"')
	const circumference = 2 * Math.PI * 7
	expect(html).toContain(`stroke-dashoffset="${circumference / 2}"`)
})

it('keeps the ring on the design tokens and stands still under reduced motion', () => {
	const css = readFileSync(new URL('./context-ring.css', import.meta.url), 'utf8')
	expect(css).toContain('var(--radius-pill)')
	expect(css).toContain('var(--focus-ring)')
	expect(css).toContain('var(--dur-base)')
	expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*transition: none/)
	expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
})

const running = () => ({ ...emptyThread(), running: true, turn: 1 })

it('stores usage per thread and keeps what the engine last said', () => {
	let thread = applyEvent(running(), {
		kind: 'usage',
		sessionId: 'a',
		contextTokens: 10,
		contextWindowTokens: 100,
		cost: 1,
	})
	expect(thread.usage).toEqual({ contextTokens: 10, contextWindowTokens: 100, cost: 1 })
	// A notice with no figures at all (a compaction note before any usage) does not erase them.
	thread = applyEvent(thread, { kind: 'usage', sessionId: 'a', compaction: 'failed' })
	expect(thread.usage).toEqual({ contextTokens: 10, contextWindowTokens: 100, cost: 1 })
	// A figure the engine now leaves out is gone, not kept stale.
	thread = applyEvent(thread, {
		kind: 'usage',
		sessionId: 'a',
		contextTokens: 20,
		contextWindowTokens: 100,
	})
	expect(thread.usage).toEqual({ contextTokens: 20, contextWindowTokens: 100 })
	expect(applyEvent(emptyThread(), { kind: 'usage', sessionId: 'a' }).usage).toBeUndefined()
})

it('shows "Compacting the conversation…" while a pass runs, then a done note, then nothing', () => {
	let thread = applyEvent(running(), { kind: 'usage', sessionId: 'a', compaction: 'started' })
	expect(thread.compaction).toEqual({ state: 'running' })
	expect(livePhaseLabel(thread)).toBe(COMPACTING_TEXT)
	expect(liveStatus(thread).stage).toEqual({ text: COMPACTING_TEXT, source: 'compaction' })
	thread = applyEvent(thread, {
		kind: 'usage',
		sessionId: 'a',
		compaction: 'finished',
		tokensBefore: 150_000,
		tokensAfter: 40_000,
		contextTokens: 40_000,
		contextWindowTokens: 200_000,
	})
	expect(thread.compaction).toEqual({ state: 'done', tokensBefore: 150_000, tokensAfter: 40_000 })
	expect(liveStatus(thread).stage).toEqual({
		text: 'Conversation compacted · 150k to 40k tokens',
		source: 'compacted',
	})
	expect(compactedText({})).toBe('Conversation compacted')
	// The turn going on replaces the note.
	thread = applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 'a',
		update: { kind: 'agent_message_chunk', text: 'Hello' },
	})
	expect(thread.compaction).toBeUndefined()
	expect(livePhaseLabel(thread)).not.toContain('ompact')
})

it('clears a running compaction when the turn ends or a new prompt starts', () => {
	const started = applyEvent(running(), { kind: 'usage', sessionId: 'a', compaction: 'started' })
	expect(
		applyEvent(started, { kind: 'state', sessionId: 'a', running: false, queued: [] }).compaction,
	).toBeUndefined()
	expect(
		applyEvent(started, { kind: 'prompt', sessionId: 'a', prompt: 'next' }).compaction,
	).toBeUndefined()
	// A failed pass ends the line at once.
	expect(
		applyEvent(started, { kind: 'usage', sessionId: 'a', compaction: 'failed' }).compaction,
	).toBeUndefined()
})

it('does not claim compaction while idle', () => {
	const idle = applyEvent(emptyThread(), { kind: 'usage', sessionId: 'a', compaction: 'started' })
	expect(livePhaseLabel(idle)).toBeUndefined()
	expect(liveStatus(idle)).toEqual({})
})

it('keeps usage for a conversation whose tab is closed', () => {
	const thread = applyClosedTabEvent(emptyThread(), {
		kind: 'usage',
		sessionId: 'a',
		contextTokens: 5000,
		contextWindowTokens: 200_000,
	})
	expect(thread.usage).toMatchObject({ contextTokens: 5000, contextWindowTokens: 200_000 })
})

it('does not reopen a closed tab on a stale compaction note', () => {
	let thread = applyClosedTabEvent(emptyThread(), {
		kind: 'state',
		sessionId: 'a',
		running: true,
		queued: [],
	})
	thread = applyClosedTabEvent(thread, { kind: 'usage', sessionId: 'a', compaction: 'started' })
	expect(thread.compaction).toEqual({ state: 'running' })
	thread = applyClosedTabEvent(thread, {
		kind: 'state',
		sessionId: 'a',
		running: false,
		queued: [],
	})
	expect(thread.running).toBe(false)
	expect(thread.compaction).toBeUndefined()
})

it('writes the bar read-out as the share and the cost, short enough to sit beside a title', () => {
	const model = contextRingModel({
		contextTokens: 28_000,
		contextWindowTokens: 200_000,
		cost: 0.06,
	})
	expect(model?.readout).toBe('14% · $0.06')
	expect(contextRingModel({ contextTokens: 28_000, contextWindowTokens: 200_000 })?.readout).toBe(
		'14%',
	)
	expect(formatCostShort(0.002)).toBe('<$0.01')
	expect(formatCostShort(0.4213)).toBe('$0.42')
})

it('draws the pie from twelve o clock, clockwise, taking the long way past half', () => {
	expect(piePath(0.25, 5, 8)).toBe('M 8 8 L 8 3 A 5 5 0 0 1 13.000 8.000 Z')
	expect(piePath(0.75, 5, 8)).toBe('M 8 8 L 8 3 A 5 5 0 1 1 3.000 8.000 Z')
})

it('draws the read-out and the Pal ring from the same measured context, and nothing without one', () => {
	const usage = { contextTokens: 28_000, contextWindowTokens: 200_000, cost: 0.06 }
	const readout = renderToStaticMarkup(createElement(ContextReadout, { usage }))
	expect(readout).toContain('14% · $0.06')
	expect(readout).toContain('aria-label="Context 14% full. 28k of 200k tokens. Cost so far $0.06."')
	expect(renderToStaticMarkup(createElement(ContextReadout, { usage: undefined }))).toBe('')
	expect(
		renderToStaticMarkup(createElement(ContextReadout, { usage: { contextTokens: 10 } })),
	).toBe('')
	expect(renderToStaticMarkup(createElement(ContextRing, { usage }))).toContain('context-ring')
})
