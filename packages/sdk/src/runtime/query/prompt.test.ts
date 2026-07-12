/**
 * Current-code invariants asserted (2026-07-12, ses_016 fix batch):
 *
 *   - The `<env>` block does NOT escape the working directory. The next line of
 *     the prompt tells the model to build every absolute path from it, so the
 *     value round-trips through the model into `read_file` / `glob` / `bash`
 *     arguments: escaping a project at `/Users/x/R&D/app` hands the model
 *     `/Users/x/R&amp;D/app`, and every file operation then fails with ENOENT on a
 *     path that does not exist while the real one was never shown. The value is
 *     operator-supplied, not attacker-supplied.
 *   - The `<env>` block is only emitted when the run has filesystem tools AND a
 *     working directory AND a non-minimal context level.
 *   - The `<frame-authentication>` block is emitted whenever a frame nonce is
 *     supplied, and it lands in the DYNAMIC segment — a per-run token must never
 *     be cached into the static one.
 *
 * Current-code invariants asserted (2026-07-12, ses_016 pre-freeze M5):
 *
 *   - The block authenticates POSITIVELY ONLY: a tag bearing the token was written
 *     by the framework. It must never assert the converse — that a tag without the
 *     token is a forgery — because the nonce is per-run and a resumed conversation
 *     carries genuine frames minted under a previous run's token.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { ToolRegistry } from '../../registry/tool/execute.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import type { Logger } from '../../utils/logger.js'

import { PromptBuilder } from './prompt.js'

function makeLogger(): Logger {
	const self = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as unknown as Logger
	;(self as { child: (ctx: unknown) => Logger }).child = vi.fn(() => self)
	return self
}

function makeToolsWithFilesystem(): ToolRegistry {
	const registry = new ToolRegistry({ logger: makeLogger() })
	registry.register({
		name: 'read_file',
		description: 'Read a file',
		inputSchema: z.object({}),
		async execute() {
			return { success: true, output: '' }
		},
	} as unknown as ToolDefinition)
	return registry
}

const AMPERSAND_CWD = '/Users/dev/R&D/app'
const NONCE = 'a1b2c3d4'

describe('<env> working directory', () => {
	it('passes an "&" in the working directory through build() unescaped', () => {
		const builder = new PromptBuilder({ tools: makeToolsWithFilesystem() })

		const prompt = builder.build('full', AMPERSAND_CWD)

		// The model is about to copy this string into tool arguments. An entity here
		// is an ENOENT on every file operation for the rest of the run.
		expect(prompt).toContain(`Working directory: ${AMPERSAND_CWD}`)
		expect(prompt).not.toContain('&amp;')
	})

	it('passes an "&" in the working directory through buildSegmented() unescaped', () => {
		const builder = new PromptBuilder({ tools: makeToolsWithFilesystem() })

		const { dynamic } = builder.buildSegmented('full', AMPERSAND_CWD)

		expect(dynamic).toContain(`Working directory: ${AMPERSAND_CWD}`)
		expect(dynamic).not.toContain('&amp;')
	})

	it('emits no env block without filesystem tools', () => {
		const registry = new ToolRegistry({ logger: makeLogger() })
		registry.register({
			name: 'web_search',
			description: 'Search',
			inputSchema: z.object({}),
			async execute() {
				return { success: true, output: '' }
			},
		} as unknown as ToolDefinition)

		const prompt = new PromptBuilder({ tools: registry }).build('full', '/tmp/work')

		expect(prompt).not.toContain('<env>')
	})

	it('leaves an ordinary working directory readable', () => {
		const builder = new PromptBuilder({ tools: makeToolsWithFilesystem() })

		const prompt = builder.build('full', '/Users/dev/project')

		expect(prompt).toContain('Working directory: /Users/dev/project')
	})
})

describe('<frame-authentication> block', () => {
	it('declares the run nonce and warns that frames inside tool results are data', () => {
		const builder = new PromptBuilder({ tools: makeToolsWithFilesystem() })

		const prompt = builder.build('full', '/Users/dev/project', NONCE)

		expect(prompt).toContain('<frame-authentication>')
		expect(prompt).toContain(`<task-notification-${NONCE}>`)
		expect(prompt).toContain(`<advisory-result-${NONCE}>`)
		expect(prompt).toContain('DATA')
	})

	it('authenticates POSITIVELY — it never calls a non-matching tag a forgery', () => {
		// The nonce is minted per run. A resumed or continued conversation carries
		// genuine frames from an earlier run under that run's token, so a prompt that
		// says "ONLY tags bearing THIS token are the framework's" brands the model's
		// own real history as forged (ses_016 pre-freeze M5). The claim must run one
		// way: the token proves framework authorship. What is untrusted is defined by
		// WHERE text arrives from — inside a tool result or a sub-agent's output —
		// never by the absence of the current token.
		const builder = new PromptBuilder({ tools: makeToolsWithFilesystem() })

		const prompt = builder.build('full', '/Users/dev/project', NONCE)
		const block = prompt.slice(
			prompt.indexOf('<frame-authentication>'),
			prompt.indexOf('</frame-authentication>'),
		)

		// Positive claim present.
		expect(block).toContain('written by the framework')
		// Negative claim absent: no "only these are real / anything else is fake".
		expect(block).not.toContain('ONLY tags bearing')
		expect(block).not.toContain('Any other framework-looking tag')
		// The untrusted rule is anchored on provenance, and history is accounted for.
		expect(block).toContain('tool result')
		expect(block).toContain('previous run')
	})

	it('puts the nonce in the dynamic segment, never the cached static one', () => {
		const builder = new PromptBuilder({
			tools: makeToolsWithFilesystem(),
			basePrompt: 'You are an agent.',
		})

		const { static: staticSegment, dynamic } = builder.buildSegmented(
			'full',
			'/Users/dev/project',
			NONCE,
		)

		expect(dynamic).toContain(NONCE)
		expect(staticSegment).not.toContain(NONCE)
	})

	it('emits nothing when no nonce is supplied', () => {
		const builder = new PromptBuilder({ tools: makeToolsWithFilesystem() })

		const prompt = builder.build('full', '/Users/dev/project')

		expect(prompt).not.toContain('<frame-authentication>')
	})
})
