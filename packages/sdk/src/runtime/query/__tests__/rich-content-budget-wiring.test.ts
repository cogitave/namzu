import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import type { RunId } from '../../../types/ids/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { ToolRegistryContract, ToolResult } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import { SPILL_MARKER } from '../tool-output-budget.js'
import { ToolingBootstrap } from '../tooling.js'

/**
 * The rich-content budget was declared on the executor's own config and read
 * in exactly one place — and no caller could set it. `ToolingBootstrapConfig`
 * had no such field, so the value the executor read was always `undefined`,
 * the cap was always `0`, and the capping branch plus its warn were
 * unreachable. A knob documented as "a host that knows its payloads sets it"
 * could not be set by any host.
 *
 * This covers the chain, not the capping: the capping is already tested
 * against an executor built by hand, which is precisely how the gap survived.
 */

const RUN_ID = '9c2a5358-a2bf-4868-9ffc-2a9cc8908f99' as RunId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function response(): ChatCompletionResponse {
	return {
		id: 'r',
		model: 'm',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'shot', arguments: '{}' } }],
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

function bootstrapReturning(
	result: ToolResult,
	maxToolContentBytes?: number,
	maxToolOutputChars?: number,
	toolOutputDir?: string,
) {
	const tools = {
		get: vi.fn(() => ({
			name: 'shot',
			isConcurrencySafe: () => true,
			isReadOnly: () => true,
			isDestructive: () => false,
		})),
		execute: vi.fn(async () => result),
		has: vi.fn(() => true),
		listNames: vi.fn(() => []),
		getAvailability: vi.fn(() => 'active'),
		register: vi.fn(),
		unregister: vi.fn(),
	} as unknown as ToolRegistryContract

	return ToolingBootstrap.init(
		{
			tools,
			...(maxToolOutputChars !== undefined ? { maxToolOutputChars } : {}),
			runId: RUN_ID,
			workingDirectory: '/tmp',
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
			...(maxToolContentBytes !== undefined ? { maxToolContentBytes } : {}),
			...(toolOutputDir ? { toolOutputDir } : {}),
		},
		new ActivityStore(RUN_ID, { enabled: false, trackToolCalls: false, trackLlmTurns: false }),
		async () => {},
		makeLogger(),
	)
}

/** An image block whose payload is comfortably over any cap set below. */
function oversizedImage(): ToolResult {
	return {
		success: true,
		output: 'captured',
		content: [
			{ type: 'text', text: 'captured' },
			{ type: 'image', mediaType: 'image/png', data: 'A'.repeat(4096) },
		],
	} as unknown as ToolResult
}

describe('the rich-content budget is reachable from the bootstrap config', () => {
	const tempDirs: string[] = []
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) removeTempDir(dir)
	})

	it('withholds an over-budget image when a host sets the cap', async () => {
		const exec = bootstrapReturning(oversizedImage(), 512)
		const batch = await exec.executeBatch(response())

		const content = batch.messages[0]?.content
		expect(Array.isArray(content)).toBe(true)
		const blocks = content as ReadonlyArray<{ type: string; text?: string }>
		expect(blocks.some((b) => b.type === 'image')).toBe(false)
		expect(blocks[0]?.text).toContain('rich content withheld')
		// The message names both the measurement and the cap, so an operator
		// can tell "too big" from "cap set too low" without a repro.
		expect(blocks[0]?.text).toContain('512')
	})

	it('retains an image beside a bounded text preview', async () => {
		const output = 'x'.repeat(5_000)
		const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'AAAA' }
		const exec = bootstrapReturning(
			{ success: true, output, content: [{ type: 'text', text: output }, image] },
			undefined,
			1_000,
		)
		const batch = await exec.executeBatch(response())
		const content = batch.messages[0]?.content
		expect(Array.isArray(content)).toBe(true)
		if (!Array.isArray(content)) throw new Error('Expected rich blocks')
		expect(content).toContainEqual(image)
		const text = content
			.filter((b) => b.type === 'text')
			.map((b) => b.text)
			.join('')
		expect(text.length).toBeLessThanOrEqual(1_000)
		expect(text).toContain('omitted')
	})

	it('does not charge model text against a small rich-content allowance', async () => {
		const text = 'model information '.repeat(300)
		const image = { type: 'image' as const, mediaType: 'image/png', data: 'AAAA' }
		const exec = bootstrapReturning(
			{ success: true, output: 'captured', content: [{ type: 'text', text }, image] },
			512,
			1_000,
		)
		const batch = await exec.executeBatch(response())
		const content = batch.messages[0]?.content
		if (!Array.isArray(content)) throw new Error('Expected rich blocks')
		expect(content).toContainEqual(image)
		const preview = content
			.filter((b) => b.type === 'text')
			.map((b) => b.text)
			.join('')
		expect(preview).toContain('model information')
		expect(preview.length).toBeLessThanOrEqual(1_000)
		expect(batch.results[0]?.output).toBe('captured')
	})

	it('caps a separate string content channel even when the host preview is tiny', async () => {
		const exec = bootstrapReturning(
			{ success: true, output: 'captured', content: 'model text '.repeat(1_000) },
			undefined,
			1_000,
		)
		const batch = await exec.executeBatch(response())
		const content = batch.messages[0]?.content
		expect(typeof content).toBe('string')
		expect(String(content).length).toBeLessThanOrEqual(1_000)
		expect(content).toContain('model text')
	})

	it('does not replace independent model evidence with a truncated host preview', async () => {
		const content = [{ type: 'text' as const, text: 'MODEL EVIDENCE' }]
		const exec = bootstrapReturning(
			{ success: true, output: 'host diagnostic '.repeat(1_000), content },
			undefined,
			1_000,
		)
		const batch = await exec.executeBatch(response())
		expect(batch.messages[0]?.content).toEqual(content)
		expect(batch.results[0]?.output.length).toBeLessThanOrEqual(1_000)
	})

	it('keeps model text and a recoverable spill when both budgets are exceeded', async () => {
		const spillDir = mkdtempSync(join(tmpdir(), 'namzu-separate-content-'))
		tempDirs.push(spillDir)
		const output = 'HOST ONLY '.repeat(1_000)
		const text = 'MODEL EVIDENCE '.repeat(1_000)
		const exec = bootstrapReturning(
			{
				success: true,
				output,
				content: [
					{ type: 'text', text },
					{ type: 'image', mediaType: 'image/png', data: 'AAAA'.repeat(1_000) },
				],
			},
			512,
			1_000,
			spillDir,
		)
		const batch = await exec.executeBatch(response())
		const content = batch.messages[0]?.content
		if (!Array.isArray(content)) throw new Error('Expected blocks')
		expect(content.some((b) => b.type === 'image')).toBe(false)
		const preview = content
			.filter((b) => b.type === 'text')
			.map((b) => b.text)
			.join('')
		expect(preview.length).toBeLessThanOrEqual(1_000)
		expect(preview).toContain('MODEL EVIDENCE')
		expect(preview).toContain('rich content withheld')
		const pointer = preview.split('\n').find((line) => line.startsWith(SPILL_MARKER))
		expect(pointer).toBeDefined()
		expect(readFileSync(pointer?.slice(SPILL_MARKER.length).trim() as string, 'utf8')).toBe(text)
		const hostFile = readdirSync(spillDir).find((name) => name.endsWith('.txt'))
		expect(readFileSync(join(spillDir, hostFile as string), 'utf8')).toBe(output)
	})

	it('keeps omission notices within even a tiny text cap', async () => {
		const exec = bootstrapReturning(oversizedImage(), 512, 32)
		const batch = await exec.executeBatch(response())
		const content = batch.messages[0]?.content
		if (!Array.isArray(content)) throw new Error('Expected blocks')
		expect(content.some((b) => b.type === 'image')).toBe(false)
		const preview = content
			.filter((b) => b.type === 'text')
			.map((b) => b.text)
			.join('')
		expect(preview.length).toBeLessThanOrEqual(32)
		expect(preview).toContain('withheld')
	})

	it('passes the same payload through untouched when no cap is set', async () => {
		const exec = bootstrapReturning(oversizedImage())
		const batch = await exec.executeBatch(response())

		const blocks = batch.messages[0]?.content as ReadonlyArray<{ type: string }>
		expect(blocks.some((b) => b.type === 'image')).toBe(true)
	})
})
