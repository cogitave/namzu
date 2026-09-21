import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import { fixtureId } from '../../../test-support/ids.js'
import type { PluginHookResult } from '../../../types/plugin/index.js'
import type { SessionEvent } from '../../../types/session/events.js'
import { ToolExecutor } from '../executor.js'

const roots: string[] = []
afterEach(async () => {
	await removeTempDirs(roots.splice(0))
})

async function execute(output: string, hook?: PluginHookResult) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-shell-evidence-'))
	roots.push(root)
	const tools = new ToolRegistry()
	const image = { type: 'image' as const, data: 'AAAA', mediaType: 'image/png' }
	tools.register({
		name: 'shell_observation',
		description: 'Return shell output.',
		category: 'shell',
		inputSchema: z.object({}),
		execute: async () => ({
			success: true,
			output,
			content: [{ type: 'text', text: output }, image],
		}),
	})
	const turnId = fixtureId.turn('shell-evidence')
	const events: SessionEvent[] = []
	const stub = { info() {}, warn() {}, error() {}, debug() {} }
	const executor = new ToolExecutor(
		{
			tools,
			sessionId: fixtureId.session('shell-evidence'),
			turnId,
			workingDirectory: root,
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
			toolOutputDir: join(root, 'output'),
			pluginManager: {
				async executeHooks(event: string) {
					return event === 'post_tool_use' && hook ? [hook] : []
				},
			} as never,
		},
		new ActivityStore(turnId, { enabled: true, trackToolCalls: true, trackLlmTurns: true }),
		async (event) => {
			events.push(event as SessionEvent)
		},
		{ ...stub, child: () => stub } as never,
	)
	const batch = await executor.executeBatch({
		id: 'r',
		model: 'm',
		finishReason: 'tool_calls',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: 'effect-once',
					type: 'function',
					function: { name: 'shell_observation', arguments: '{}' },
				},
			],
		},
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
	})
	const completed = events.find((event) => event.type === 'tool_completed')!
	expect(completed.type).toBe('tool_completed')
	if (completed.type !== 'tool_completed') throw new Error('Missing completion')
	expect(completed.outputSpillIntegrity).toMatch(/^[a-f0-9]{64}$/)
	return {
		completed,
		outcome: batch.results[0]!,
		retained: await readFile(completed.outputSpillPath!, 'utf8'),
		image,
	}
}

it.each([30, 4_000])(
	'retains %s distinct shell rows while condensing both visible text channels',
	async (rows) => {
		const output = Array.from(
			{ length: rows },
			(_, i) => `Observation ${i}: count ${i + 10} α🦉`,
		).join('\n')
		const { completed, outcome, retained, image } = await execute(output)
		expect(retained).toBe(output)
		expect(outcome.output).toContain('similar lines omitted')
		expect(outcome.output).not.toContain('Observation 20: count 30')
		expect(outcome.output.length).toBeLessThan(2_000)
		expect(completed.outputLength).toBe(output.length)
		expect(completed.outputTruncated).toBe(true)
		expect(outcome.content).toEqual([{ type: 'text', text: outcome.output }, image])
	},
)

it.each(['replace', 'error'] as const)('retains only the post-hook %s decision', async (action) => {
	const secret = 'PRIVATE-TEXT-MUST-NOT-BE-RETAINED'
	const replacement = 'Public permitted observation.\n'.repeat(3_000)
	const { retained, completed, outcome } = await execute(
		secret,
		action === 'error' ? { action, message: replacement } : { action, output: replacement },
	)
	expect(retained).toBe(action === 'error' ? `Error: ${replacement}` : replacement)
	expect(retained).not.toContain(secret)
	expect(outcome.output).not.toContain(secret)
	expect(completed.isError).toBe(action === 'error')
})
