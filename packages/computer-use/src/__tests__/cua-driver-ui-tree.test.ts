/**
 * A window's controls through cua-driver: `get_window_state` read into the
 * host's `UiSnapshot`, and `uiAct` driving a control by the element token it
 * was given. The records below are cut from a real answer for the Windows 10
 * Calculator (Turkish UI) and classic Notepad, cua-driver 0.28.2.
 */
import { describe, expect, it } from 'vitest'
import { SubprocessComputerUseHost } from '../SubprocessComputerUseHost.js'
import { CuaDriverAdapter } from '../adapters/cua-driver/adapter.js'
import { toUiTree } from '../adapters/cua-driver/ui-tree.js'
import {
	type FakeMcpProcess,
	type FakeServerScript,
	type ToolCall,
	fakeSpawner,
	toolResult,
} from './fake-mcp-process.js'

const CALCULATOR_MARKDOWN = [
	'- Window "Hesap Makinesi"',
	'  - [0] Window "Hesap Makinesi" [value="Hesap Makinesi" id=TitleBar actions=[set_value]]',
	'    - MenuBar "System"',
	'      - [1] MenuItem "System" [actions=[expand]]',
	'    - [4] Button "Close Hesap Makinesi" [id=Close actions=[invoke]]',
	'  - Window "Hesap Makinesi"',
	'    - [5] Text "Hesap Makinesi" [id=AppName actions=[text]]',
	'        - Text "İfade değeri 125 × 8="',
	'        - [8] Text "Ekran değeri 1,000" [id=CalculatorResults actions=[invoke]]',
	'        - Group "Sayı takımı"',
	'          - [25] Button "Sıfır" [id=num0Button actions=[invoke]]',
	'          - [30] Button "Beş" [id=num5Button actions=[invoke]]',
].join('\n')

const CALCULATOR_ELEMENTS = [
	{
		actions: ['set_value'],
		element_index: 0,
		element_token: 's00000002:0',
		enabled: true,
		frame: { h: 32, w: 188, x: 151, y: 17 },
		label: 'Hesap Makinesi',
		role: 'Window',
		value: 'Hesap Makinesi',
	},
	{
		actions: ['expand'],
		element_index: 1,
		element_token: 's00000002:1',
		enabled: true,
		label: 'System',
		parent_index: 0,
		role: 'MenuItem',
	},
	{
		actions: ['invoke'],
		element_index: 4,
		element_token: 's00000002:4',
		enabled: true,
		frame: { h: 32, w: 46, x: 293, y: 17 },
		label: 'Close Hesap Makinesi',
		parent_index: 0,
		role: 'Button',
	},
	{
		actions: ['text'],
		element_index: 5,
		element_token: 's00000002:5',
		enabled: true,
		label: 'Hesap Makinesi',
		role: 'Text',
	},
	{
		actions: ['invoke'],
		element_index: 8,
		element_token: 's00000002:8',
		enabled: true,
		frame: { h: 75, w: 320, x: 19, y: 120 },
		label: 'Ekran değeri 1,000',
		role: 'Text',
	},
	{
		actions: ['invoke'],
		element_index: 25,
		element_token: 's00000002:25',
		enabled: false,
		frame: { h: 45, w: 76, x: 101, y: 455 },
		label: 'Sıfır',
		role: 'Button',
	},
	{
		actions: ['invoke'],
		element_index: 30,
		element_token: 's00000002:30',
		enabled: true,
		frame: { h: 45, w: 76, x: 101, y: 360 },
		label: 'Beş',
		role: 'Button',
	},
]

const CALCULATOR_STATE = {
	app_name: 'ApplicationFrameHost.exe',
	elements: CALCULATOR_ELEMENTS,
	pid: 11432,
	snapshot_id: 's00000002',
	tree_markdown: CALCULATOR_MARKDOWN,
	window_id: 2494982,
	window_title: 'Hesap Makinesi',
}

const NOTEPAD_STATE = {
	app_name: 'notepad.exe',
	elements: [
		{
			actions: ['set_value', 'scroll'],
			element_index: 0,
			element_token: 's00000003:0',
			enabled: true,
			frame: { h: 798, w: 804, x: 2608, y: 201 },
			label: 'Text Editor',
			role: 'Edit',
		},
	],
	pid: 58056,
	snapshot_id: 's00000003',
	tree_markdown: [
		'- Window "Untitled - Notepad"',
		'  - [0] Edit "Text Editor" [id=15 actions=[set_value,scroll]]',
		'  - StatusBar "Status Bar"',
		'    - Text "  Ln 1, Col 1"',
	].join('\n'),
	window_id: 15468924,
	window_title: 'Untitled - Notepad',
}

describe('cua-driver UI trees', () => {
	it('keeps every node of the walk, with refs only on controls this host can drive', () => {
		const tree = toUiTree(CALCULATOR_STATE)
		const root = tree.root
		expect(root).toMatchObject({ role: 'Window', name: 'Hesap Makinesi', ref: '' })
		const titleBar = root.children?.[0]
		expect(titleBar).toMatchObject({
			ref: 's00000002:0',
			role: 'Window',
			automationId: 'TitleBar',
			actions: ['set_value'],
			bounds: { x: 151, y: 17, width: 188, height: 32 },
		})
		// An unindexed row keeps its role and name; the expand-only menu item
		// can be expanded or collapsed.
		expect(titleBar?.children?.[0]).toMatchObject({ role: 'MenuBar', name: 'System', ref: '' })
		expect(titleBar?.children?.[0]?.children?.[0]).toMatchObject({
			ref: 's00000002:1',
			actions: ['expand', 'collapse'],
		})
		const content = root.children?.[1]
		const appName = content?.children?.[0]
		// A text control with nothing to do gets no ref, and its children still hang under it.
		expect(appName).toMatchObject({ role: 'Text', name: 'Hesap Makinesi', ref: '' })
		expect(appName?.children?.map((child) => [child.role, child.name, child.ref])).toEqual([
			['Text', 'İfade değeri 125 × 8=', ''],
			['Text', 'Ekran değeri 1,000', 's00000002:8'],
			['Group', 'Sayı takımı', ''],
		])
		const pad = appName?.children?.[2]?.children ?? []
		expect(pad[0]).toMatchObject({
			name: 'Sıfır',
			states: ['disabled'],
			automationId: 'num0Button',
		})
		expect(pad[1]).toMatchObject({ name: 'Beş', ref: 's00000002:30', actions: ['invoke'] })
		expect([...tree.refs.keys()]).toEqual([
			's00000002:0',
			's00000002:1',
			's00000002:4',
			's00000002:8',
			's00000002:25',
			's00000002:30',
		])
		expect(tree.refs.get('s00000002:0')).toEqual({ value: 'Hesap Makinesi' })
	})

	it('nests the records by parent_index when there is no markdown', () => {
		const { tree_markdown: _ignored, ...withoutMarkdown } = CALCULATOR_STATE
		const tree = toUiTree(withoutMarkdown)
		expect(tree.root).toMatchObject({ role: 'Window', name: 'Hesap Makinesi', ref: '' })
		const titleBar = tree.root.children?.find((child) => child.ref === 's00000002:0')
		expect(titleBar?.children?.map((child) => child.ref)).toEqual(['s00000002:1', 's00000002:4'])
		expect(tree.refs.size).toBe(6)
	})
})

/** A cua-driver stand-in with one Calculator and one Notepad window. */
function driver(
	overrides: Partial<Record<string, (call: ToolCall, p: FakeMcpProcess) => unknown>>,
) {
	const script: FakeServerScript = {
		tool: (call, process) => {
			const override = overrides[call.name]
			if (override) return override(call, process) as never
			switch (call.name) {
				case 'get_screen_size':
					return toolResult({ width: 3440, height: 1440, scale_factor: 1 })
				case 'list_windows':
					return toolResult({
						windows: [
							{
								window_id: 15468924,
								pid: 58056,
								app_name: 'notepad.exe',
								title: 'Untitled - Notepad',
								bounds: { x: 2607, y: 150, width: 806, height: 873 },
								z_index: 9,
							},
							{
								window_id: 2494982,
								pid: 11432,
								app_name: 'ApplicationFrameHost.exe',
								title: 'Hesap Makinesi',
								bounds: { x: 18, y: 16, width: 322, height: 534 },
								z_index: 8,
							},
						],
					})
				case 'get_window_state':
					return toolResult(call.arguments.window_id === 2494982 ? CALCULATOR_STATE : NOTEPAD_STATE)
				default:
					return toolResult({ effect: 'unverifiable', route: 'accessibility' })
			}
		},
	}
	const spawner = fakeSpawner(script)
	const adapter = new CuaDriverAdapter({
		executable: '/cache/cua-driver.exe',
		env: {},
		spawnProcess: spawner.spawnProcess,
		requestTimeoutMs: 1_000,
		startTimeoutMs: 1_000,
	})
	const calls = () =>
		spawner.processes
			.flatMap((p) => p.toolCalls)
			.filter((c) => c.name !== 'set_agent_cursor_enabled')
	return { adapter, calls }
}

describe('the cua-driver adapter’s UI tree', () => {
	it('declares uiTree and reads a listed window by its id, without a screenshot', async () => {
		const { adapter, calls } = driver({})
		expect(adapter.capabilities.uiTree).toBe(true)
		const snapshot = await adapter.uiSnapshot('0x261206')
		expect(snapshot).toMatchObject({
			windowId: '0x261206',
			title: 'Hesap Makinesi',
			app: 'ApplicationFrameHost',
			root: { name: 'Hesap Makinesi' },
		})
		expect(calls().map((c) => c.name)).toEqual(['list_windows', 'get_window_state'])
		expect(calls()[1]?.arguments).toEqual({
			pid: 11432,
			window_id: 2494982,
			include_screenshot: false,
			max_elements: 1500,
		})
		await adapter.dispose()
	})

	it('reads the window in front when no id is given', async () => {
		const { adapter, calls } = driver({})
		const snapshot = await adapter.uiSnapshot()
		expect(snapshot.windowId).toBe('0xec097c')
		expect(calls()[1]?.arguments).toMatchObject({ pid: 58056, window_id: 15468924 })
		await adapter.dispose()
	})

	it('invokes a control by its token, in the background', async () => {
		const { adapter, calls } = driver({})
		await adapter.uiSnapshot('0x261206')
		await expect(adapter.uiAct('s00000002:30', 'invoke')).resolves.toEqual({ ok: true })
		await expect(adapter.uiAct('s00000002:1', 'expand')).resolves.toEqual({ ok: true })
		expect(calls().slice(-2)).toEqual([
			{ name: 'click', arguments: { pid: 11432, element_token: 's00000002:30' } },
			{ name: 'click', arguments: { pid: 11432, element_token: 's00000002:1' } },
		])
		await adapter.dispose()
	})

	it('refuses a ref from anything but the latest snapshot without calling the driver', async () => {
		const { adapter, calls } = driver({})
		await adapter.uiSnapshot('0x261206')
		await adapter.uiSnapshot('0xec097c')
		const before = calls().length
		await expect(adapter.uiAct('s00000002:30', 'invoke')).resolves.toEqual({
			ok: false,
			detail: expect.stringContaining('not a control of the latest UI snapshot'),
		})
		expect(calls()).toHaveLength(before)
		await adapter.dispose()
	})

	it('types into an empty field that has no settable value, and says so', async () => {
		const { adapter, calls } = driver({
			set_value: () => ({
				result: {
					isError: true,
					content: [
						{
							type: 'text',
							text: 'set_value: element [0] does not implement ValuePattern or RangeValuePattern.',
						},
					],
				},
			}),
		})
		await adapter.uiSnapshot('0xec097c')
		await expect(
			adapter.uiAct('s00000003:0', 'set_value', 'Merhaba dünya ığüşöç'),
		).resolves.toEqual({
			ok: true,
			detail: 'typed into the empty field, which has no settable value',
		})
		expect(calls().slice(-2)).toEqual([
			{
				name: 'set_value',
				arguments: { pid: 58056, element_token: 's00000003:0', value: 'Merhaba dünya ığüşöç' },
			},
			{
				name: 'type_text',
				arguments: { pid: 58056, element_token: 's00000003:0', text: 'Merhaba dünya ığüşöç' },
			},
		])
		await adapter.dispose()
	})

	it('does not type into a field that already holds text, since that would not replace it', async () => {
		const { adapter, calls } = driver({
			get_window_state: () =>
				toolResult({
					...NOTEPAD_STATE,
					elements: [{ ...NOTEPAD_STATE.elements[0], value: 'already here' }],
				}),
			set_value: () => ({
				result: {
					isError: true,
					content: [{ type: 'text', text: 'element [0] does not implement ValuePattern' }],
				},
			}),
		})
		await adapter.uiSnapshot('0xec097c')
		const result = await adapter.uiAct('s00000003:0', 'set_value', 'new')
		expect(result.ok).toBe(false)
		expect(result.detail).toMatch(/already holds text/)
		expect(calls().some((c) => c.name === 'type_text')).toBe(false)
		await adapter.dispose()
	})

	it('reports a stale token, a refusal and a suspected no-op as not done', async () => {
		let answer = 0
		const { adapter } = driver({
			click: () => {
				answer += 1
				if (answer === 1)
					return {
						result: {
							isError: true,
							content: [
								{
									type: 'text',
									text: 'element_token is stale; call get_window_state again to refresh',
								},
							],
						},
					}
				if (answer === 2)
					return toolResult({
						effect: 'refused',
						route: 'accessibility',
						refusal: { message: 'the control is disabled' },
					})
				return toolResult({ effect: 'suspected_noop', route: 'accessibility' })
			},
		})
		await adapter.uiSnapshot('0x261206')
		await expect(adapter.uiAct('s00000002:30', 'invoke')).resolves.toEqual({
			ok: false,
			detail: 'that control is from an older UI snapshot; take a new one',
		})
		await expect(adapter.uiAct('s00000002:30', 'invoke')).resolves.toEqual({
			ok: false,
			detail: 'the control is disabled',
		})
		await expect(adapter.uiAct('s00000002:30', 'invoke')).resolves.toMatchObject({ ok: false })
		await adapter.dispose()
	})

	it('through the host: forwarded, and an action lost to a crash is an unknown outcome, not a retry', async () => {
		let crashed = false
		const { adapter } = driver({
			click: (_call, process) => {
				if (!crashed) {
					crashed = true
					process.crash(1)
					return { hang: true }
				}
				return toolResult({ effect: 'confirmed', route: 'accessibility' })
			},
		})
		const host = new SubprocessComputerUseHost({ adapter })
		expect(host.capabilities.uiTree).toBe(true)
		await host.uiSnapshot('0x261206')
		const result = await host.uiAct('s00000002:30', 'invoke')
		expect(result.ok).toBe(false)
		expect(result.detail).toMatch(/may or may not have happened/)
		await host.dispose()
	})
})
