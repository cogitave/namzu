import { describe, expect, it, vi } from 'vitest'

import type { PluginId, SessionId } from '../../types/ids/index.js'
import { PluginLifecycleManager } from '../lifecycle.js'

/**
 * Hooks left the manager only by plugin id. A hook attached for a while (a
 * skill's, for as long as the skill is in use) needs a handle that removes
 * exactly what one call attached.
 */

const SESSION_ID = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId
const SHARED = 'p_shared' as PluginId

function makeManager(): PluginLifecycleManager {
	const logger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		child: () => logger,
	}
	return new PluginLifecycleManager({
		pluginRegistry: {} as never,
		scopeRoots: { project: process.cwd(), user: process.cwd() },
		log: logger as never,
	})
}

const answers = (name: string, order: string[]) => async () => {
	order.push(name)
	return { action: 'continue' as const }
}

async function fire(manager: PluginLifecycleManager): Promise<void> {
	await manager.executeHooks('pre_tool_use', { sessionId: SESSION_ID, toolName: 'bash' })
}

describe('attachHooks', () => {
	it('removes exactly the hooks its call attached, beside hooks of the same plugin id', async () => {
		const manager = makeManager()
		const order: string[] = []
		manager.registerHook(SHARED, { event: 'pre_tool_use', handler: answers('config', order) })
		const attachment = manager.attachHooks(SHARED, [
			{ event: 'pre_tool_use', handler: answers('skill-a', order) },
			{ event: 'post_tool_use', handler: answers('skill-b', order) },
		])
		expect(attachment.size).toBe(2)
		expect(manager.listHooks()).toHaveLength(3)

		await fire(manager)
		expect(order).toEqual(['config', 'skill-a'])

		expect(attachment.remove()).toBe(2)
		order.length = 0
		await fire(manager)
		expect(order).toEqual(['config'])
		expect(manager.listHooks()).toEqual([{ pluginId: SHARED, event: 'pre_tool_use' }])
	})

	it('can be removed twice, and the second time removes nothing', () => {
		const manager = makeManager()
		const attachment = manager.attachHooks(SHARED, [
			{ event: 'pre_tool_use', handler: answers('a', []) },
		])
		expect(attachment.remove()).toBe(1)
		expect(attachment.remove()).toBe(0)
	})

	it('removes one hook of an attachment by its position', async () => {
		const manager = makeManager()
		const order: string[] = []
		const attachment = manager.attachHooks(SHARED, [
			{ event: 'pre_tool_use', handler: answers('first', order) },
			{ event: 'pre_tool_use', handler: answers('second', order) },
		])
		expect(attachment.removeAt(0)).toBe(true)
		expect(attachment.removeAt(0)).toBe(false)
		expect(attachment.removeAt(7)).toBe(false)
		await fire(manager)
		expect(order).toEqual(['second'])
	})

	it('keeps answering order when hooks come and go: a later hook never takes an earlier one’s place', async () => {
		const manager = makeManager()
		const order: string[] = []
		manager.registerHook(SHARED, { event: 'pre_tool_use', handler: answers('one', order) })
		const gone = manager.attachHooks(SHARED, [
			{ event: 'pre_tool_use', handler: answers('two', order) },
		])
		gone.remove()
		manager.registerHook(SHARED, { event: 'pre_tool_use', handler: answers('three', order) })
		manager.registerHook(SHARED, { event: 'pre_tool_use', handler: answers('four', order) })
		await fire(manager)
		expect(order).toEqual(['one', 'three', 'four'])
	})

	it('attaches none of the hooks when one names an event nothing emits', () => {
		const manager = makeManager()
		expect(() =>
			manager.attachHooks(SHARED, [
				{ event: 'pre_tool_use', handler: answers('ok', []) },
				{ event: 'run_start' as never, handler: answers('renamed', []) },
			]),
		).toThrow()
		expect(manager.listHooks()).toEqual([])
	})

	it('lets an event that already started finish with the hooks it found', async () => {
		const manager = makeManager()
		const order: string[] = []
		const attachment = manager.attachHooks(SHARED, [
			{
				event: 'pre_tool_use',
				handler: async () => {
					order.push('first')
					attachment.remove()
					return { action: 'continue' as const }
				},
			},
			{ event: 'pre_tool_use', handler: answers('second', order) },
		])
		await fire(manager)
		expect(order.sort()).toEqual(['first', 'second'])
		order.length = 0
		await fire(manager)
		expect(order).toEqual([])
	})
})
