/**
 * What the adapter tells the presence overlay: where the agent acts, in
 * virtual-desktop pixels, never failing or delaying the action itself.
 */
import { describe, expect, it } from 'vitest'
import { CuaDriverAdapter } from '../adapters/cua-driver/adapter.js'
import type { Presence, PresenceMark } from '../presence/index.js'
import { type FakeServerScript, fakeSpawner, pngHeader, toolResult } from './fake-mcp-process.js'

class RecordingPresence implements Presence {
	readonly marks: PresenceMark[] = []
	warmed = 0
	mark(mark: PresenceMark): void {
		this.marks.push(mark)
	}
	warm(): void {
		this.warmed += 1
	}
	hide(): void {}
	async dispose(): Promise<void> {}
}

function driver(presence: Presence) {
	const script: FakeServerScript = {
		tool: (call) => {
			switch (call.name) {
				case 'list_windows':
					return toolResult({
						windows: [
							{
								window_id: 0x111,
								pid: 42,
								title: 'Notes',
								app_name: 'editor.exe',
								bounds: { x: 100, y: 80, width: 1200, height: 700 },
								z_index: 1,
							},
						],
					})
				case 'get_window_state':
					return toolResult(
						{
							pid: 42,
							window_id: 0x111,
							window_bounds: { x: 100, y: 80, width: 1200, height: 700 },
							screenshot_width: 600,
							screenshot_height: 350,
							tree_markdown: '- [0] Button "Save"',
							elements: [
								{
									element_index: 0,
									element_token: 'e0',
									role: 'Button',
									label: 'Save',
									enabled: true,
									actions: ['invoke'],
									frame: { x: 300, y: 200, w: 100, h: 40 },
								},
							],
						},
						[
							{
								type: 'image',
								data: pngHeader(600, 350).toString('base64'),
								mimeType: 'image/png',
							},
						],
					)
				case 'click':
					return toolResult({ effect: 'unverifiable', delivery: { mode: 'background' } })
				default:
					return toolResult({})
			}
		},
	}
	const spawner = fakeSpawner(script)
	return new CuaDriverAdapter({
		executable: '/cache/cua-driver.exe',
		env: {},
		spawnProcess: spawner.spawnProcess,
		requestTimeoutMs: 1_000,
		startTimeoutMs: 1_000,
		presence,
	})
}

describe('presence marks from the Windows adapter', () => {
	it('has the overlay ready as soon as the model looks at windows', async () => {
		const presence = new RecordingPresence()
		const adapter = driver(presence)
		await adapter.listWindows()
		expect(presence.warmed).toBe(1)
		await adapter.dispose()
	})

	it('puts a window click where it lands on the screen, scaling the capture to the window', async () => {
		const presence = new RecordingPresence()
		const adapter = driver(presence)
		const shot = await adapter.captureWindow('0x111')
		await adapter.executeWindow(shot.captureId, {
			type: 'mouse_click',
			at: { x: 100, y: 50 },
			button: 'left',
		})
		// The window is 1200 wide and its capture 600: two window pixels per capture pixel.
		expect(presence.marks).toEqual([{ hwnd: 0x111, kind: 'click', at: { x: 300, y: 180 } }])
		await adapter.dispose()
	})

	it('marks typing without a point, so the cursor stays where it is', async () => {
		const presence = new RecordingPresence()
		const adapter = driver(presence)
		const shot = await adapter.captureWindow('0x111')
		await adapter.executeWindow(shot.captureId, { type: 'type_text', text: 'hello' })
		expect(presence.marks).toEqual([{ hwnd: 0x111, kind: 'type' }])
		await adapter.dispose()
	})

	it('puts a control action at the centre of the control', async () => {
		const presence = new RecordingPresence()
		const adapter = driver(presence)
		const snapshot = await adapter.uiSnapshot('0x111')
		const button = snapshot.root.children?.find((child) => child.name === 'Save') ?? snapshot.root
		const ref = button.ref !== '' ? button.ref : (snapshot.root.children?.[0]?.ref as string)
		await adapter.uiAct(ref, 'invoke')
		expect(presence.marks.at(-1)).toEqual({ hwnd: 0x111, kind: 'click', at: { x: 350, y: 220 } })
		await adapter.dispose()
	})

	it('never fails or waits on the overlay', async () => {
		const throwing: Presence = {
			mark: () => {
				throw new Error('overlay broke')
			},
			warm: () => undefined,
			hide: () => undefined,
			dispose: async () => undefined,
		}
		const adapter = driver(throwing)
		const shot = await adapter.captureWindow('0x111')
		await expect(
			adapter.executeWindow(shot.captureId, {
				type: 'mouse_click',
				at: { x: 1, y: 1 },
				button: 'left',
			}),
		).resolves.toMatchObject({ delivery: expect.stringMatching(/^delivered/) })
		await adapter.dispose()
	})
})
