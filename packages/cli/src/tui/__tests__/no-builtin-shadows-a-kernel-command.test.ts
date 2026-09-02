import { describe, expect, it } from 'vitest'

import {
	CLI_LOCAL_COMMANDS,
	HOST_OWNED_COMMAND_NAMES,
	kernelCommandDescriptors,
	mergeHostCommands,
} from '../slashCommands.js'

/**
 * The merge throws on a name both sides register — at boot, inside App's
 * render, which is the worst place to learn it. So the real builtin list
 * is merged with the real kernel list here, where a collision fails a
 * test instead of the first launch after the commit.
 */
describe('the builtin commands and the kernel commands', () => {
	it('share no name the host has not claimed', () => {
		const owned = new Set<string>(HOST_OWNED_COMMAND_NAMES)
		const kernel = new Set(
			kernelCommandDescriptors()
				.map((c) => c.name)
				.filter((name) => !owned.has(name)),
		)
		const clashes = CLI_LOCAL_COMMANDS.map((c) => c.name).filter((name) => kernel.has(name))
		expect(clashes).toEqual([])
		expect(() => mergeHostCommands(kernelCommandDescriptors())).not.toThrow()
	})
})
