/**
 * A `SKILL.md` on disk reaches the model: listed in the prompt's manifest,
 * loaded through the `skill` tool, and visible as such in `exec --json`.
 *
 * Driven through the real `exec --json` handler and the real session; only the
 * provider is scripted. The script answers like a model that matched the
 * request to a description: it calls `skill` with the name it found in the
 * manifest, and only if it found it there — so the assertion covers the
 * manifest, the tool and the event stream in one road rather than three units.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { type ChatCompletionParams, MockLLMProvider, ProviderRegistry } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'

import type { CommandContext } from '../commands/types.js'
import { type DetectedProvider, PROVIDER_REGISTRY } from '../integrations/providers/index.js'

vi.mock('../tui/agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../tui/agent.js')>()
	const providerId = 'anthropic' as const
	return {
		...actual,
		probeAgentSession: vi.fn(async () => ({
			preferences: {
				version: 3 as const,
				providers: [{ id: providerId, model: 'claude-sonnet-4-5' }],
				subagents: { active: [] as string[] },
			},
			needsRepickReason: null,
			credentialGap: null,
			detected: [
				{
					entry: PROVIDER_REGISTRY[providerId],
					source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
					apiKey: 'not-a-real-key',
					alternatives: [],
				},
			] as DetectedProvider[],
		})),
	}
})

let cwd: string
let realStdin: PropertyDescriptor | undefined

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), 'namzu-skill-reach-'))
	mkdirSync(join(cwd, '.git'))
	const dir = join(cwd, '.agents', 'skills', 'release-notes')
	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, 'SKILL.md'),
		[
			'---',
			'name: release-notes',
			'description: Write release notes for this project. Use when asked for release notes or a changelog entry.',
			'argument-hint: [version]',
			'---',
			'Start every release note with the line RELEASE-NOTES-SKILL-WAS-HERE.',
		].join('\n'),
	)
	realStdin ??= Object.getOwnPropertyDescriptor(process, 'stdin')
	Object.defineProperty(process, 'stdin', {
		configurable: true,
		get: () => Object.assign(Readable.from([]), { isTTY: false }),
	})
})

afterEach(() => {
	vi.restoreAllMocks()
	if (realStdin) Object.defineProperty(process, 'stdin', realStdin)
	removeTempDir(cwd)
})

function systemText(params: ChatCompletionParams): string {
	return params.messages
		.filter((message) => message.role === 'system')
		.map((message) => (typeof message.content === 'string' ? message.content : ''))
		.join('\n')
}

async function execJson(prompt: string, config: Record<string, unknown> = {}) {
	const provider = new MockLLMProvider({
		nextTurn: (params, index) => {
			if (index === 0) {
				return systemText(params).includes('<name>release-notes</name>')
					? { toolCalls: [{ id: 'load', name: 'skill', args: { name: 'release-notes' } }] }
					: { text: 'No skill matched.' }
			}
			return { text: 'RELEASE-NOTES-SKILL-WAS-HERE\n- fixed things' }
		},
	})
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const lines: string[] = []
	vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
		lines.push(String(chunk))
		return true
	})
	const { execCommand } = await import('../commands/exec.js')
	const ctx = {
		formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} },
		config,
	} as unknown as CommandContext
	await execCommand.handler({
		rawArgs: ['--json', '--trust', '--cwd', cwd, prompt],
		ctx,
	} as never)
	vi.mocked(process.stdout.write).mockRestore()
	const events = lines
		.flatMap((chunk) => chunk.split('\n'))
		.filter((line) => line.trim().startsWith('{'))
		.map((line) => JSON.parse(line) as Record<string, unknown>)
	return { events, provider }
}

describe('a file skill', () => {
	it('is listed to the model and loaded through the skill tool, visibly in exec --json', async () => {
		const { events, provider } = await execJson('Write the release notes for 1.2.0')

		expect(events.filter((event) => event.kind === 'error')).toEqual([])
		const first = provider.requests[0]
		expect(first, 'the turn never reached the provider').toBeDefined()
		expect(systemText(first!)).toContain('<name>release-notes</name>')
		expect(first!.tools?.map((tool) => tool.function.name)).toContain('skill')

		expect(events).toContainEqual(
			expect.objectContaining({
				kind: 'tool-start',
				toolName: 'skill',
				summary: JSON.stringify({ name: 'release-notes' }),
			}),
		)
		expect(events).toContainEqual(
			expect.objectContaining({
				kind: 'tool-end',
				toolName: 'skill',
				isError: false,
				output: expect.stringContaining('RELEASE-NOTES-SKILL-WAS-HERE'),
			}),
		)
		// The tool result carried the body back to the model.
		const results = provider.requests[1]?.messages.filter((message) => message.role === 'tool')
		expect(JSON.stringify(results)).toContain('RELEASE-NOTES-SKILL-WAS-HERE')
		expect(events.at(-1)).toMatchObject({ kind: 'done' })
	})

	it('is not offered when the config disables it', async () => {
		const { provider } = await execJson('Write the release notes for 1.2.0', {
			// Built-ins off too: they would bring the skill tool on their own.
			skills: { disabled: ['release-notes'], builtin: false },
		})

		const first = provider.requests[0]
		expect(systemText(first!)).not.toContain('release-notes')
		expect(first!.tools?.map((tool) => tool.function.name) ?? []).not.toContain('skill')
	})
})
