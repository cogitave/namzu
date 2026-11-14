import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { type FixtureSession, sessionLogText, writeSession } from './__fixtures__/logs.js'
import {
	buildSessionCostTool,
	fileLogBytes,
	readSessionCost,
	renderSessionCost,
} from './session-cost.js'

let home: string
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-session-cost-'))
})
afterEach(() => removeTempDir(home))

const call = (at: string, costUsd: number, unpriced = 0) => ({
	at,
	prompt: 1000,
	completion: 200,
	cacheRead: 400,
	costUsd,
	unpriced,
})

async function runTool(session: FixtureSession) {
	const { path } = writeSession(home, session)
	const tool = buildSessionCostTool(() => fileLogBytes(path))
	return tool.execute({}, { turnId: 'turn-0' } as unknown as ToolContext)
}

describe('session_cost', () => {
	it('is read-only and takes no arguments', () => {
		const tool = buildSessionCostTool(() => {
			throw new Error('unused')
		})
		expect(tool.name).toBe('session_cost')
		expect(tool.isReadOnly?.({})).toBe(true)
		expect(tool.description).toMatch(/what this conversation has cost/)
	})

	it('adds every turn, names the last completed one and says the charge was reported', async () => {
		const result = await runTool({
			turns: [
				{
					startAt: '2026-01-01T10:00:00.000Z',
					model: 'deepseek/deepseek-v4.1-flash-1017',
					servingProvider: 'openrouter',
					endAt: '2026-01-01T10:01:00.000Z',
					calls: [call('2026-01-01T10:00:10.000Z', 0.004), call('2026-01-01T10:00:20.000Z', 0.002)],
				},
				{
					startAt: '2026-01-01T10:02:00.000Z',
					model: 'deepseek/deepseek-v4.1-flash-1017',
					servingProvider: 'openrouter',
					endAt: '2026-01-01T10:03:00.000Z',
					calls: [call('2026-01-01T10:02:10.000Z', 0.0031)],
				},
			],
		})
		expect(result.success).toBe(true)
		expect(result.output).toContain('This conversation so far: $0.0091.')
		expect(result.output).toContain('Last completed turn: $0.0031.')
		expect(result.output).toContain('OpenRouter')
		expect(result.output).toContain('Not included')
		expect(result.output).toContain('dashboard')
	})

	it('says the figures are estimates from list prices when no provider reports a charge', async () => {
		const result = await runTool({
			turns: [
				{
					startAt: '2026-01-01T10:00:00.000Z',
					model: 'm',
					servingProvider: 'anthropic',
					endAt: '2026-01-01T10:01:00.000Z',
					calls: [call('2026-01-01T10:00:10.000Z', 0.02)],
				},
			],
		})
		expect(result.output).toContain('estimate from list prices')
		expect(result.output).not.toContain('OpenRouter')
	})

	it('counts a turn that is still running', async () => {
		const result = await runTool({
			turns: [
				{
					startAt: '2026-01-01T10:00:00.000Z',
					model: 'm',
					endAt: '2026-01-01T10:01:00.000Z',
					calls: [call('2026-01-01T10:00:10.000Z', 0.01)],
				},
				{
					startAt: '2026-01-01T10:02:00.000Z',
					model: 'm',
					calls: [call('2026-01-01T10:02:10.000Z', 0.005)],
				},
			],
		})
		expect(result.output).toContain('This conversation so far: $0.0150.')
		expect(result.output).toContain('Last completed turn: $0.0100.')
	})

	it('says the price is not known, never zero, when no call has a rate', async () => {
		const result = await runTool({
			turns: [
				{
					startAt: '2026-01-01T10:00:00.000Z',
					model: 'deepseek-chat',
					endAt: '2026-01-01T10:01:00.000Z',
					calls: [call('2026-01-01T10:00:10.000Z', 0, 1200)],
				},
			],
		})
		expect(result.output).toContain('price not known')
		expect(result.output).toContain('1,200 tokens')
		expect(result.output).not.toMatch(/\$0\.00/)
		expect(result.output).not.toMatch(/cost nothing|free of charge/)
	})

	it('says "at least" when only some tokens have a rate', async () => {
		const result = await runTool({
			turns: [
				{
					startAt: '2026-01-01T10:00:00.000Z',
					model: 'm',
					endAt: '2026-01-01T10:01:00.000Z',
					calls: [call('2026-01-01T10:00:10.000Z', 0.01, 300)],
				},
			],
		})
		expect(result.output).toContain('at least $0.0100 (300 tokens at no known rate)')
		expect(result.output).toContain('higher than this')
	})

	it('says the calls still to come in this turn are not counted yet', async () => {
		const result = await runTool({
			turns: [
				{
					startAt: '2026-01-01T10:00:00.000Z',
					model: 'm',
					calls: [call('2026-01-01T10:00:10.000Z', 0.01)],
				},
			],
		})
		expect(result.output).toMatch(/still to come in this turn/)
		expect(result.output).toMatch(/not counted yet/)
		expect(result.output).toMatch(/cost so far, not as the final total/)
	})

	it('reads the provider from the record, in whatever pieces the log arrives', async () => {
		const { text } = sessionLogText({
			turns: [
				{
					startAt: '2026-01-01T10:00:00.000Z',
					model: 'm',
					servingProvider: 'openrouter',
					endAt: '2026-01-01T10:01:00.000Z',
					calls: [call('2026-01-01T10:00:10.000Z', 0.01)],
				},
			],
		})
		const bytes = Buffer.from(text, 'utf8')
		async function* pieces(size: number) {
			for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size)
		}
		for (const size of [1, 7, 96, 97, bytes.length]) {
			const reading = await readSessionCost(pieces(size))
			expect(reading.providers, `pieces of ${size} bytes`).toEqual(['openrouter'])
		}
	})

	it('does not read a provider out of text a record merely contains', async () => {
		// Not an assistant message, yet the same JSON shape sits raw in the line.
		const spoof = JSON.stringify({
			type: 'message',
			role: 'user',
			content: {
				role: 'user',
				content: 'hello',
				source: { type: 'model', providerId: 'openrouter', model: 'x', chainIndex: 0 },
			},
		})
		const { text } = sessionLogText({
			turns: [
				{
					startAt: '2026-01-01T10:00:00.000Z',
					model: 'm',
					servingProvider: 'anthropic',
					endAt: '2026-01-01T10:01:00.000Z',
					calls: [call('2026-01-01T10:00:10.000Z', 0.01)],
				},
			],
		})
		async function* all() {
			yield Buffer.from(`${spoof}\n${text}`, 'utf8')
		}
		expect((await readSessionCost(all())).providers).toEqual(['anthropic'])
	})

	it('says nothing is recorded yet, without calling it free', async () => {
		const reading = await readSessionCost(fileLogBytes(join(home, 'missing.jsonl')))
		expect(reading.hasCalls).toBe(false)
		expect(renderSessionCost(reading)).toMatch(/No cost is recorded/)
	})

	it('fails with a plain sentence when the turn does not own a conversation', async () => {
		const tool = buildSessionCostTool(() => {
			throw new Error('The requesting turn does not own this conversation.')
		})
		const result = await tool.execute({}, {} as unknown as ToolContext)
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/could not be read/)
	})
})
