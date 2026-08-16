import { HostCommandRegistry, kernelHostCommands } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import {
	CLI_LOCAL_COMMANDS,
	CommandNameCollisionError,
	hostCommandNames,
	kernelCommandDescriptors,
	matchSlashCommands,
	mergeHostCommands,
	renderOutcome,
} from '../slashCommands.js'

/**
 * `SLASH_COMMANDS` was a hardcoded literal, and nothing a capability added
 * could reach the operator without editing that file.
 *
 * Two headless commands already borrowed the array for a name list, so the
 * coupling had escaped the TUI: a name they did not know was sent to the
 * MODEL as prose, silently, which is both a wrong answer and a tool call
 * nobody asked for.
 */

describe('a command the kernel registers reaches the operator', () => {
	it('appears in the merged set with no edit to the CLI', () => {
		// The whole claim of the change. Deleting the merge makes this fail.
		const names = mergeHostCommands(kernelCommandDescriptors()).map((c) => c.name)

		expect(names).toContain('tasks')
		expect(names).toContain('agents')
	})

	it('is offered by autocomplete', () => {
		const merged = mergeHostCommands(kernelCommandDescriptors())

		expect(matchSlashCommands('/ta', [], merged).map((c) => c.name)).toContain('tasks')
	})

	it('is known to the headless path, so it is not sent to the model as prose', () => {
		// The failure mode a name list can have and a dropdown cannot: an
		// unrecognised `/command` becomes a prompt.
		expect(hostCommandNames()).toContain('tasks')
	})

	it('keeps the CLI-local commands first', () => {
		const merged = mergeHostCommands(kernelCommandDescriptors())

		expect(merged.slice(0, CLI_LOCAL_COMMANDS.length).map((c) => c.name)).toEqual(
			CLI_LOCAL_COMMANDS.map((c) => c.name),
		)
	})
})

describe('a name claimed twice is refused, not shadowed', () => {
	it('throws with the name in it', () => {
		// One of the two would never run, which depends on merge order, and
		// neither the kernel nor the host author would ever see it.
		expect(() => mergeHostCommands([{ name: 'clear', description: 'a kernel clear' }])).toThrow(
			CommandNameCollisionError,
		)
		expect(() => mergeHostCommands([{ name: 'clear', description: 'a kernel clear' }])).toThrow(
			/clear/,
		)
	})
})

describe('an outcome is drawn by the host, not the kernel', () => {
	it('renders a report with its rows', async () => {
		const registry = new HostCommandRegistry()
		registry.register(kernelHostCommands({ allowedAgentIds: ['reviewer', 'writer'] }))

		const outcome = await registry.dispatch('/agents')

		expect(outcome).toBeDefined()
		if (!outcome) return
		const rendered = renderOutcome(outcome)
		expect(rendered).toContain('Agents (2)')
		expect(rendered).toContain('reviewer')
	})

	it('renders a refusal as its reason, not as an empty table', async () => {
		// "There are none" and "I cannot look" are different answers, and the
		// kernel already keeps them apart — this is the half that shows them
		// apart.
		const registry = new HostCommandRegistry()
		registry.register(kernelHostCommands({}))

		const outcome = await registry.dispatch('/tasks')

		expect(outcome?.kind).toBe('refused')
		if (!outcome) return
		expect(renderOutcome(outcome)).toMatch(/no task store/i)
	})

	it('says "none" for an empty report rather than printing a header alone', async () => {
		const registry = new HostCommandRegistry()
		registry.register(kernelHostCommands({ allowedAgentIds: [] }))

		const outcome = await registry.dispatch('/agents')

		expect(outcome && renderOutcome(outcome)).toBe('Agents: none.')
	})
})
