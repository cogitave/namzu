/**
 * The line a background agent leaves when it fails: the outcome is the
 * glyph's colour, the sentence is plain primary text with no duration, the
 * provider's JSON and request ids are cleaned off it, and the provider's own
 * text is one ctrl+o away.
 */

import { createRequire } from 'node:module'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import { Transcript } from '../Transcript.js'
import { agentNotice, failureReason } from '../agent-transcript-rows.js'
import { agentCompletionRows } from '../restored-rows.js'
import { theme } from '../theme.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as { level: number }
const originalLevel = chalk.level
beforeAll(() => {
	chalk.level = 3
})
afterAll(() => {
	chalk.level = originalLevel
})

const paletteOf = (color: string) => `palette:${/\((\d+)\)/.exec(color)?.[1]}`

const screens: Screen[] = []
afterEach(async () => {
	for (const screen of screens.splice(0)) await screen.unmount()
})

const RAW =
	'API Error: 400 {"error":{"message":"credit balance too low","request_id":"req_abc12345"}}'

function failed(text: string, extra: Partial<SubagentActivity> = {}): SubagentActivity {
	return {
		viewId: 'a',
		agentId: 'general-purpose',
		description: 'Audit the config',
		prompt: 'p',
		batchId: 'b',
		workflowId: 'w',
		workflowGroupId: 'g',
		phaseId: 'p',
		workflow: 'Delegated work',
		phase: 'Work',
		phaseSequence: 0,
		status: 'failed',
		startedAt: 0,
		completedAt: 6_000,
		transcript: [{ id: 'a:failure', kind: 'system', text }],
		...extra,
	} as SubagentActivity
}

describe('the notice for an agent that failed', () => {
	it('says the plain sentence from a provider body, with no JSON, id or duration', () => {
		expect(agentNotice(failed(RAW)).content).toBe(
			'Agent "Audit the config" failed: credit balance too low',
		)
	})

	it('falls back to the one-line text when there is nothing to clean', () => {
		expect(agentNotice(failed('Provider refused the request')).content).toBe(
			'Agent "Audit the config" failed: Provider refused the request',
		)
	})

	it('folds a repeat of the same raw reason, and not two raws that clean alike', () => {
		const first = failed(RAW)
		expect(agentNotice(first, 1, failureReason(first)).content).toBe(
			'Agent "Audit the config" failed again',
		)
		const other = RAW.replace('req_abc12345', 'req_zzz99999')
		expect(agentNotice(failed(other), 1, failureReason(first)).content).toBe(
			'Agent "Audit the config" failed: credit balance too low',
		)
	})

	it('keeps the duration on a finished agent and on a stopped one', () => {
		expect(agentNotice(failed('x', { status: 'completed' })).content).toBe(
			'Agent "Audit the config" finished · 6s',
		)
		expect(agentNotice(failed('x', { status: 'cancelled' })).content).toBe(
			'Agent "Audit the config" was stopped · 6s',
		)
	})
})

describe('the row an agent failure leaves', () => {
	it('keeps the raw text behind ctrl+o, and has no body when nothing was cleaned', () => {
		const [row] = agentCompletionRows(failed(RAW))
		expect(row?.detail).toEqual([failureReason(failed(RAW))])
		expect(row?.meta).toBe('(ctrl+o to expand)')
		const [plain] = agentCompletionRows(failed('Provider refused the request'))
		expect(plain?.detail).toBeUndefined()
	})

	it('colours the glyph by outcome and the sentence as primary text', async () => {
		const row = agentCompletionRows(failed(RAW))[0]
		if (!row) throw new Error('expected a row')
		const message: TranscriptMessage = { id: 'r', detailRef: 1, ...row }
		const screen = await renderToScreen(
			<Transcript messages={[message]} pending={null} state="idle" settled={0} resetKey={0} />,
			{ cols: 100, rows: 20 },
		)
		screens.push(screen)
		await screen.waitForRender()
		const at = screen.viewport().findIndex((line) => line.includes('Agent "Audit'))
		const text = screen.row(at)
		expect(text).toContain('failed: credit balance too low')
		expect(text).not.toContain('req_')
		expect(screen.cell(at, text.indexOf('●')).fg).toBe(paletteOf(theme.status.error))
		expect(screen.cell(at, text.indexOf('Agent')).fg).toBe(paletteOf(theme.text.primary))
	})
})
