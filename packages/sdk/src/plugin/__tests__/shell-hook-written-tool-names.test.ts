import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { vi } from 'vitest'

import type { PluginHookContext } from '../../types/plugin/index.js'
import { asSessionId, asTurnId } from '../../utils/id.js'
import { SHELL_HOOK_WRITTEN_TOOL_NAMES, shellHookToolName } from '../shell-hook-tool-names.js'
import { createShellHook, runShellHook, shellHookPayload } from '../shell-hook.js'

const base = { event: 'pre_tool_use' as const, cwd: '/p', sessionId: 's' }

describe('the written spelling of a tool name', () => {
	it('is the capitalised name for a tool that has one, and ours for one that has none', () => {
		expect(shellHookToolName('bash', 'written')).toBe('Bash')
		expect(shellHookToolName('web_fetch', 'written')).toBe('WebFetch')
		expect(shellHookToolName('search_tools', 'written')).toBe('ToolSearch')
		expect(shellHookToolName('Agent', 'written')).toBe('Agent')
		expect(shellHookToolName('job', 'written')).toBe('job')
		expect(shellHookToolName('view_image', 'written')).toBe('view_image')
	})

	it('leaves a tool-server tool and an unknown name as they are', () => {
		expect(shellHookToolName('mcp__github__get_issue', 'written')).toBe('mcp__github__get_issue')
		expect(shellHookToolName('toString', 'written')).toBe('toString')
		expect(shellHookToolName('constructor', 'written')).toBe('constructor')
	})

	it('is not applied unless the entry asks for it', () => {
		expect(shellHookToolName('bash', undefined)).toBe('bash')
		expect(shellHookToolName('bash', 'namzu')).toBe('bash')
	})

	it('sends tool_name in the written spelling and nothing else changes', () => {
		const own = JSON.parse(
			shellHookPayload({
				...base,
				toolName: 'edit',
				toolCallId: 'c1',
				toolInput: { path: 'a.ts' },
			}),
		)
		const written = JSON.parse(
			shellHookPayload({
				...base,
				toolName: 'edit',
				toolCallId: 'c1',
				toolInput: { path: 'a.ts' },
				toolNames: 'written',
			}),
		)
		expect(own.tool_name).toBe('edit')
		expect(written.tool_name).toBe('Edit')
		expect({ ...written, tool_name: 'edit' }).toEqual(own)
		expect(written.tool_use_id).toBe('c1')
		expect(written.tool_input).toEqual({ path: 'a.ts', file_path: 'a.ts' })
	})

	it('writes the names inside tool_calls on a batch', () => {
		const payload = JSON.parse(
			shellHookPayload({
				...base,
				event: 'post_tool_batch',
				toolNames: 'written',
				toolCalls: [
					{ toolName: 'bash', toolCallId: 'a', toolInput: {}, output: '', isError: false },
					{ toolName: 'job', toolCallId: 'b', toolInput: {}, output: '', isError: false },
				],
			}),
		)
		expect(payload.tool_calls.map((call: { tool_name: string }) => call.tool_name)).toEqual([
			'Bash',
			'job',
		])
	})

	it('reaches the payload of an entry through createShellHook (a prompt hook shows it)', async () => {
		const seen: string[] = []
		const judge = vi.fn().mockImplementation(async (request: { body: string }) => {
			seen.push(request.body)
			return '{"ok": true}'
		})
		const context = {
			event: 'pre_tool_use',
			sessionId: asSessionId('0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b'),
			turnId: asTurnId('f9ad17f0-01b6-4905-810a-3ef3324a614d'),
			toolName: 'bash',
			toolInput: { command: 'ls' },
			signal: new AbortController().signal,
		} as unknown as PluginHookContext
		for (const toolNames of [undefined, 'written'] as const) {
			const hook = createShellHook(
				'pre_tool_use',
				{ type: 'prompt', prompt: 'ok?', ...(toolNames ? { toolNames } : {}) },
				{ cwd: process.cwd(), judge },
			) as unknown as { handler: (c: PluginHookContext) => Promise<unknown> }
			await hook.handler(context)
		}
		expect(seen.map((body) => /"tool_name":"([^"]+)"/.exec(body)?.[1])).toEqual(['bash', 'Bash'])
	})

	// A real child process: the environment is read by the program, not the payload.
	it('sets NAMZU_TOOL_NAME in the spelling the entry asked for', async () => {
		const entry = { command: 'printf %s "$NAMZU_TOOL_NAME"' }
		const real = { ...base, cwd: process.cwd() }
		const own = await runShellHook(entry, { ...real, toolName: 'bash' })
		const written = await runShellHook(entry, { ...real, toolName: 'bash', toolNames: 'written' })
		expect(own.stdout).toBe('bash')
		expect(written.stdout).toBe('Bash')
	}, 20_000)
})

describe('the written names on the hooks page', () => {
	const page = readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			'..',
			'..',
			'..',
			'..',
			'..',
			'docs',
			'sdk',
			'hooks.md',
		),
		'utf8',
	)
	const block =
		/<!-- written-tool-names:start -->([\s\S]*?)<!-- written-tool-names:end -->/.exec(page)?.[1] ??
		''
	const rows = [...block.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gm)].map(
		(match) => [match[1] as string, match[2] as string] as const,
	)

	it('are exactly the code table', () => {
		expect(block).not.toBe('')
		expect(Object.fromEntries(rows)).toEqual(SHELL_HOOK_WRITTEN_TOOL_NAMES)
		expect(rows).toHaveLength(Object.keys(SHELL_HOOK_WRITTEN_TOOL_NAMES).length)
	})
})
