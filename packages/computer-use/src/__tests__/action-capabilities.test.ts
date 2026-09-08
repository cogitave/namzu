import { createComputerUseTool } from '@namzu/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SubprocessComputerUseHost } from '../SubprocessComputerUseHost.js'
import { DarwinAdapter } from '../adapters/darwin.js'
import { LinuxWaylandAdapter } from '../adapters/linux-wayland.js'
import { LinuxX11Adapter } from '../adapters/linux-x11.js'
import { Win32Adapter } from '../adapters/win32.js'
import { hasExecutable, runCommandOrThrow } from '../util/spawn.js'

vi.mock('../util/spawn.js', async (original) => ({
	...(await original<typeof import('../util/spawn.js')>()),
	hasExecutable: vi.fn(),
	runCommandOrThrow: vi.fn(async () => ({
		stdout: Buffer.alloc(0),
		stderr: '',
		exitCode: 0,
		timedOut: false,
		signal: null,
	})),
}))

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(hasExecutable).mockResolvedValue(true)
})

describe('native adapter action declarations', () => {
	it('macOS without cliclick advertises clicks and typing, never move, drag or scroll', async () => {
		vi.mocked(hasExecutable).mockImplementation(async (name) => name !== 'cliclick')
		const adapter = await DarwinAdapter.create()
		const tool = createComputerUseTool(new SubprocessComputerUseHost({ adapter }))
		expect(adapter.capabilities.supportedActions).toEqual([
			'screenshot',
			'mouse_click',
			'type_text',
			'key',
		])
		expect(tool.modelInputSchema).toMatchObject({
			properties: {
				type: { enum: ['screenshot', 'mouse_click', 'type_text', 'key'] },
				button: { enum: ['left'] },
			},
		})
		await expect(
			adapter.execute({ type: 'scroll', at: { x: 0, y: 0 }, direction: 'down', amount: 1 }),
		).rejects.toThrow('scroll is not supported')
		expect(runCommandOrThrow).not.toHaveBeenCalled()
	})

	it('macOS refuses middle clicks and non-left drags instead of executing a different gesture', async () => {
		const adapter = await DarwinAdapter.create()
		expect(adapter.capabilities.supportedActions).not.toContain('scroll')
		expect(adapter.capabilities.mouseClickButtons).toEqual(['left', 'right'])
		expect(adapter.capabilities.mouseDragButtons).toEqual(['left'])
		await expect(
			adapter.execute({ type: 'mouse_click', at: { x: 2, y: 3 }, button: 'middle' }),
		).rejects.toThrow('middle-click')
		await expect(
			adapter.execute({
				type: 'mouse_drag',
				from: { x: 2, y: 3 },
				to: { x: 4, y: 5 },
				button: 'right',
			}),
		).rejects.toThrow('left button')
		expect(runCommandOrThrow).not.toHaveBeenCalled()
		await adapter.execute({ type: 'mouse_click', at: { x: 2, y: 3 }, button: 'right' })
		expect(runCommandOrThrow).toHaveBeenCalledWith('cliclick', ['rc:2,3'])
	})

	it('Wayland with wtype and grim only exposes screenshots and keyboard actions', async () => {
		vi.mocked(hasExecutable).mockImplementation(async (name) => ['grim', 'wtype'].includes(name))
		const adapter = await LinuxWaylandAdapter.create()
		expect(adapter.capabilities.supportedActions).toEqual(['screenshot', 'type_text', 'key'])
		expect(
			createComputerUseTool(new SubprocessComputerUseHost({ adapter })).modelInputSchema,
		).toMatchObject({ properties: { type: { enum: ['screenshot', 'type_text', 'key'] } } })
	})

	it.each([
		['X11', LinuxX11Adapter.create],
		['Windows', Win32Adapter.create],
	] as const)('%s publishes all implemented action types', async (_name, create) => {
		const adapter = await create()
		expect(new Set(adapter.capabilities.supportedActions)).toEqual(
			new Set([
				'screenshot',
				'cursor_position',
				'mouse_move',
				'mouse_click',
				'mouse_drag',
				'scroll',
				'type_text',
				'key',
			]),
		)
		expect(Object.isFrozen(adapter.capabilities.supportedActions)).toBe(true)
	})
})
