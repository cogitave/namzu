/**
 * A `.md` file on disk becomes a prompt the model is actually sent.
 *
 * The loader returning a well-formed object proves nothing about whether the
 * text ever leaves the CLI. This is genuinely new code rather than a call into
 * existing machinery — `discoverSkills` finds directories containing a
 * `SKILL.md` and returns `[]` for a folder of loose `.md` files — so the road
 * from the file to the provider is new too, and reachability is its own
 * property (`docs/conventions/reachability-is-its-own-property.md`).
 *
 * So this drives the real dispatch and the real session, and asserts on what
 * `query()` was handed. The chain has four links and a unit test sits on one
 * side of every break:
 *
 *   file on disk → discoverUserCommands → runSlash → prompt action → query()
 *
 * The assertion is the command's TEMPLATE text arriving in the message the
 * kernel is given. Asserting that `runSlash` returned `{kind:'prompt'}` would
 * pass with the App never sending it.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'

import { CLI_LOCAL_COMMANDS, type SlashContext, runSlash } from '../tui/slashCommands.js'
import { discoverUserCommands } from '../user-commands/store.js'

const queryCalls: Record<string, unknown>[] = []
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Record<string, unknown>) => {
			queryCalls.push(params)
			return (async function* () {})()
		},
	}
})

let cwd: string

beforeEach(() => {
	queryCalls.length = 0
	cwd = mkdtempSync(join(tmpdir(), 'namzu-cmd-reach-'))
})

afterEach(() => {
	removeTempDir(cwd)
})

function writeCommand(name: string, body: string): void {
	const dir = join(cwd, '.namzu', 'commands')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, name), body)
}

function context(userCommands: SlashContext['userCommands']): SlashContext {
	return {
		availableTools: () => [],
		sandbox: null,
		mcp: null,
		lastAssistantMessageId: () => null,
		providerSummary: 'mock (mock)',
		modelSummary: 'mock-model',
		usage: null,
		permissions: {
			skipPermissions: false,
			rules: [],
			approvalLatched: () => false,
			neverPrompted: () => [],
		},
		instructionFiles: [],
		userCommands,
		configDebug: null,
	}
}

describe('a command file the operator wrote', () => {
	it('reaches the model as the prompt for a turn', async () => {
		writeCommand('audit.md', 'Audit $ARGUMENTS for unchecked errors.')

		// Real discovery, from the real directory layout.
		const commands = discoverUserCommands({
			home: cwd,
			cwd,
			reserved: CLI_LOCAL_COMMANDS.map((c) => c.name),
		})
		expect(
			commands.map((c) => c.name),
			'the file was not discovered',
		).toEqual(['audit'])

		// Real dispatch.
		const action = runSlash('/audit src/parse.ts', context(commands))
		expect(action?.kind, 'dispatch did not turn it into a turn').toBe('prompt')
		const text = action?.kind === 'prompt' ? action.text : ''
		expect(text).toBe('Audit src/parse.ts for unchecked errors.')

		// Real session, mocked provider. This is the link the earlier assertions
		// cannot cover: that the composed text is what the kernel is given.
		const { createAgentSession } = await import('../tui/agent.js')
		const session = await createAgentSession(
			{ version: 3, providers: [{ id: 'anthropic' }], subagents: { active: [] } } as never,
			[
				{
					entry: {
						id: 'anthropic',
						label: 'Anthropic',
						defaultModel: 'claude-sonnet-4-5',
						requiresApiKey: true,
						envVars: ['ANTHROPIC_API_KEY'],
					},
					source: 'env',
					apiKey: 'sk-ant-not-a-real-key',
					alternatives: [],
				} as never,
			],
			{ cwd },
		)
		for await (const _ of session.send([{ role: 'user', content: text, timestamp: 0 }])) {
			// drain
		}

		expect(queryCalls.length, 'the turn never reached query()').toBe(1)
		const messages = queryCalls[0]?.messages as ReadonlyArray<{ content: unknown }> | undefined
		const sent = messages?.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
		expect(sent, 'the file’s text is not in what the model was sent').toContain(
			'Audit src/parse.ts for unchecked errors.',
		)
	})

	it('does not reach the model when the file cannot be read', async () => {
		// Refusing has to stop the turn, not merely annotate it. A broken command
		// that still sends something would be worse than one that sends nothing.
		writeCommand('broken.md', '---\nunclosed frontmatter')
		const commands = discoverUserCommands({ home: cwd, cwd })

		const action = runSlash('/broken', context(commands))
		expect(action?.kind).toBe('message')
		expect(queryCalls.length).toBe(0)
	})
})
