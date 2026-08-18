import { HostCommandRegistry, kernelHostCommands } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import {
	CLI_LOCAL_COMMANDS,
	CommandNameCollisionError,
	HOST_OWNED_COMMAND_NAMES,
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
		expect(names).toContain('goal')
	})

	it('is offered by autocomplete', () => {
		const merged = mergeHostCommands(kernelCommandDescriptors())

		expect(matchSlashCommands('/ta', [], merged).map((c) => c.name)).toContain('tasks')
		expect(matchSlashCommands('/go', [], merged).map((c) => c.name)).toContain('goal')
	})

	it('is known to the headless path, so it is not sent to the model as prose', () => {
		// The failure mode a name list can have and a dropdown cannot: an
		// unrecognised `/command` becomes a prompt.
		expect(hostCommandNames()).toContain('tasks')
		expect(hostCommandNames()).toContain('goal')
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

describe('a name this host implements itself', () => {
	it('declines the kernel’s version rather than colliding with it', () => {
		// `/skills` is the case that made this necessary. The kernel's lists
		// what a registry holds; this host's discovers from disk, marks which
		// are active, and shows a refused one with its reason. Both are right
		// for their audience — so the kernel keeps offering it and this host
		// declines, in writing.
		const merged = mergeHostCommands(kernelCommandDescriptors())

		expect(merged.filter((c) => c.name === 'skills')).toHaveLength(1)
		expect(HOST_OWNED_COMMAND_NAMES).toContain('skills')
	})

	it('keeps the LOCAL implementation, not the kernel’s', () => {
		// Detected by what it does: the local one produces a `list-skills`
		// action, the kernel's would produce a `host-command`.
		const merged = mergeHostCommands(kernelCommandDescriptors())
		const skills = merged.find((c) => c.name === 'skills')

		expect(skills?.action({} as never, [])).toMatchObject({ kind: 'list-skills' })
	})

	it('still REFUSES a collision nobody decided about', () => {
		// The filter is a list of deliberate exceptions, not a precedence
		// rule. First-wins or last-wins would make an accidental collision
		// silent, which is what the refusal exists to prevent.
		expect(() =>
			mergeHostCommands([
				{ name: 'clear', description: 'a kernel command that shadows a local one' },
			]),
		).toThrow(CommandNameCollisionError)
	})

	it('still takes every kernel command this host does NOT own', () => {
		const merged = mergeHostCommands(kernelCommandDescriptors())

		expect(merged.map((c) => c.name)).toContain('agents')
		expect(merged.map((c) => c.name)).toContain('tasks')
	})
})
