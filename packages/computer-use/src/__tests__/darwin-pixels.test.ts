/**
 * macOS captures physical pixels and takes input in points. The host contract
 * is physical pixels both ways, so the adapter converts at its boundary — or
 * a Retina click aimed by the SDK at pixel (2000, 1000) lands at point
 * (2000, 1000), twice as far from the origin as intended.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => ({
	commands: [] as Array<{ command: string; args: readonly string[] }>,
	cursor: '700,400',
}))

/** A PNG header is all the adapter reads: width and height from IHDR. */
function pngHeader(width: number, height: number): Buffer {
	const header = Buffer.alloc(33)
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
	header.writeUInt32BE(width, 16)
	header.writeUInt32BE(height, 20)
	return header
}

vi.mock('node:fs/promises', () => ({
	readFile: async () => pngHeader(2880, 1800),
	unlink: async () => {},
}))

vi.mock('../util/spawn.js', () => ({
	hasExecutable: async () => true,
	runCommand: async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 }),
	runCommandOrThrow: async (command: string, args: readonly string[]) => {
		spawn.commands.push({ command, args })
		const stdout =
			command === 'system_profiler'
				? JSON.stringify({
						SPDisplaysDataType: [
							{
								spdisplays_ndrvs: [
									{
										_spdisplays_resolution: '1440 x 900 @ 60.00Hz',
										_spdisplays_pixels: '2880 x 1800',
									},
								],
							},
						],
					})
				: command === 'cliclick' && args[0] === 'p'
					? spawn.cursor
					: ''
		return { stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), exitCode: 0, timedOut: false }
	},
}))

const { DarwinAdapter } = await import('../adapters/darwin.js')

beforeEach(() => {
	spawn.commands.length = 0
})

describe('DarwinAdapter on a Retina display', () => {
	it('reports the capture in physical pixels with its display and scale factor', async () => {
		const adapter = await DarwinAdapter.create()
		const result = await adapter.execute({ type: 'screenshot' })
		expect(result.type).toBe('screenshot')
		if (result.type !== 'screenshot') return
		expect(result.result).toMatchObject({
			width: 2880,
			height: 1800,
			display: { id: 'main', x: 0, y: 0, width: 2880, height: 1800, scaleFactor: 2, primary: true },
		})
		expect(spawn.commands[0]?.args).toContain('-m')
	})

	it('turns physical pixels into points for every input and points back for the cursor', async () => {
		const adapter = await DarwinAdapter.create()
		await adapter.execute({ type: 'screenshot' })
		spawn.commands.length = 0
		await adapter.execute({ type: 'mouse_click', at: { x: 2000, y: 1000 }, button: 'left' })
		await adapter.execute({ type: 'mouse_click', at: { x: 2001, y: 999 }, button: 'right' })
		await adapter.execute({ type: 'mouse_move', to: { x: 10, y: 20 } })
		await adapter.execute({
			type: 'mouse_drag',
			from: { x: 100, y: 100 },
			to: { x: 300, y: 500 },
			button: 'left',
		})
		expect(spawn.commands.map((call) => call.args)).toEqual([
			['c:1000,500'],
			['rc:1001,500'],
			['m:5,10'],
			['dd:50,50', 'du:150,250'],
		])
		const cursor = await adapter.execute({ type: 'cursor_position' })
		expect(cursor).toEqual({ type: 'cursor_position', point: { x: 1400, y: 800 } })
	})

	it('converts before any capture using the display geometry', async () => {
		const adapter = await DarwinAdapter.create()
		await adapter.execute({ type: 'mouse_click', at: { x: 2000, y: 1000 }, button: 'left' })
		expect(spawn.commands.map((call) => call.command)).toEqual(['system_profiler', 'cliclick'])
		expect(spawn.commands[1]?.args).toEqual(['c:1000,500'])
	})
})
