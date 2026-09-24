import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { PLUGIN_NAMESPACE_SEPARATOR } from '../../../constants/plugin/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { ToolManager } from '../../../toolsets/manager.js'
import { assertToolName } from '../execute.js'

/**
 * A tool name reaches the provider verbatim, and the major message APIs
 * accept `[a-zA-Z0-9_-]` only. Nothing checked it: names were derived by
 * concatenation at three separate construction sites, and the plugin
 * bridge's separator was a colon — so EVERY plugin-contributed tool name
 * was illegal, unconditionally.
 *
 * The rejection is a 400 on the whole request rather than on that tool,
 * and those tools are registered deferred, so it fired the moment one was
 * activated with nothing naming the culprit.
 */

const tool = (name: string) => ({
	name,
	description: 'x',
	inputSchema: z.object({}),
	execute: async () => ({ success: true as const, output: 'ok' }),
})

describe('what a name may be', () => {
	it.each(['read', 'read_file', 'read-file', 'mcp__srv__read', 'a'.repeat(64)])(
		'accepts %s',
		(name) => {
			expect(() => assertToolName(name)).not.toThrow()
		},
	)

	it.each([
		['a colon', 'plugin:tool'],
		['a space', 'read file'],
		['a dot', 'fs.read'],
		['a slash', 'fs/read'],
		['an empty name', ''],
	])('refuses %s', (_why, name) => {
		expect(() => assertToolName(name)).toThrow(/cannot be sent to a provider/)
	})

	it('refuses a name over the length limit and says so', () => {
		expect(() => assertToolName('a'.repeat(65))).toThrow(/65 characters, over the 64/)
	})

	it('names the offending tool', () => {
		// A 400 on the whole request names nothing; this has to.
		expect(() => assertToolName('bad:name')).toThrow(/"bad:name"/)
	})
})

describe('the manager', () => {
	it('refuses at construction rather than at request time', () => {
		// Failing here costs the turn nothing and can still be attributed.
		expect(
			() =>
				new ToolManager({
					toolsets: [testToolset(tool('plugin:tool') as never)],
					messages: () => [],
				}),
		).toThrow(/cannot be sent to a provider/)
	})

	it('still admits a legal name', () => {
		const manager = new ToolManager({
			toolsets: [testToolset(tool('read_file') as never)],
			messages: () => [],
		})
		expect(manager.listNames()).toContain('read_file')
	})
})

describe('the plugin namespace separator', () => {
	it('is itself legal, so plugin tools can register at all', () => {
		// It was a colon, which made every plugin-contributed tool name
		// illegal — the check above would refuse all of them.
		expect(() => assertToolName(`plugin${PLUGIN_NAMESPACE_SEPARATOR}tool`)).not.toThrow()
	})

	it('produces a legal name for a bridged remote tool', () => {
		const name = `fs-plugin${PLUGIN_NAMESPACE_SEPARATOR}mcp__fs__read_file`
		expect(() => assertToolName(name)).not.toThrow()
	})
})
