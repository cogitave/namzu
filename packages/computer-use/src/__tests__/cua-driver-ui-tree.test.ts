/**
 * A window's controls through cua-driver: `get_window_state` read into the
 * host's `UiSnapshot`, and `uiAct` driving a control by the element token it
 * was given. The records below are cut from a real answer for the Windows 10
 * Calculator (Turkish UI) and classic Notepad, cua-driver 0.28.2.
 */
import type { UiElementAction, UiSnapshot } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { SubprocessComputerUseHost } from '../SubprocessComputerUseHost.js'
import { CuaDriverAdapter, type CuaDriverAdapterOptions } from '../adapters/cua-driver/adapter.js'
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

function refFor(snapshot: UiSnapshot, name: string, action?: UiElementAction): string {
	const pending = [snapshot.root]
	while (pending.length > 0) {
		const element = pending.pop()
		if (!element) continue
		if (element.name === name && element.ref && (!action || element.actions?.includes(action)))
			return element.ref
		pending.push(...(element.children ?? []))
	}
	throw new Error(`no actionable control named ${name}`)
}

describe('cua-driver UI trees nesting', () => {
	it('does not put rows under a control that holds nothing when the driver skipped a level', () => {
		const tree = toUiTree({
			elements: [
				{ element_index: 0, element_token: 't0', role: 'Button', label: 'Go', actions: ['invoke'] },
				{
					element_index: 1,
					element_token: 't1',
					role: 'Button',
					label: 'Buy',
					actions: ['invoke'],
				},
			],
			tree_markdown: [
				'- Window "W"',
				'  - [0] Button "Go" [actions=[invoke]]',
				'      - ListItem "Row"',
				'        - [1] Button "Buy" [actions=[invoke]]',
			].join('\n'),
		})
		const go = tree.root.children?.find((c) => c.name === 'Go')
		expect(go?.children).toBeUndefined()
		expect(tree.root.children?.some((c) => c.name === 'Row')).toBe(true)
	})
})

describe('cua-driver UI trees', () => {
	it('keeps every node of the walk, with refs only on controls this host can drive', () => {
		const tree = toUiTree(CALCULATOR_STATE)
		const root = tree.root
		expect(root).toMatchObject({
			role: 'Window',
			name: 'Hesap Makinesi',
			ref: '',
		})
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
		expect(titleBar?.children?.[0]).toMatchObject({
			role: 'MenuBar',
			name: 'System',
			ref: '',
		})
		expect(titleBar?.children?.[0]?.children?.[0]).toMatchObject({
			ref: 's00000002:1',
			actions: ['expand', 'collapse'],
		})
		const content = root.children?.[1]
		const appName = content?.children?.[0]
		// A text control with nothing to do gets no ref, and its children still hang under it.
		expect(appName).toMatchObject({
			role: 'Text',
			name: 'Hesap Makinesi',
			ref: '',
		})
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
		expect(pad[1]).toMatchObject({
			name: 'Beş',
			ref: 's00000002:30',
			actions: ['invoke'],
		})
		expect([...tree.refs.keys()]).toEqual([
			's00000002:0',
			's00000002:1',
			's00000002:4',
			's00000002:8',
			's00000002:25',
			's00000002:30',
		])
		expect(tree.refs.get('s00000002:0')).toMatchObject({
			value: 'Hesap Makinesi',
			role: 'Window',
			automationId: 'TitleBar',
		})
	})

	it('nests the records by parent_index when there is no markdown', () => {
		const { tree_markdown: _ignored, ...withoutMarkdown } = CALCULATOR_STATE
		const tree = toUiTree(withoutMarkdown)
		expect(tree.root).toMatchObject({
			role: 'Window',
			name: 'Hesap Makinesi',
			ref: '',
		})
		const titleBar = tree.root.children?.find((child) => child.ref === 's00000002:0')
		expect(titleBar?.children?.map((child) => child.ref)).toEqual(['s00000002:1', 's00000002:4'])
		expect(tree.refs.size).toBe(6)
	})
})

/** A cua-driver stand-in with one Calculator and one Notepad window. */
function driver(
	overrides: Partial<Record<string, (call: ToolCall, p: FakeMcpProcess) => unknown>>,
	extra: { foreground?: CuaDriverAdapterOptions['foreground'] } = {},
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
		settle: async () => undefined,
		...(extra.foreground ? { foreground: extra.foreground } : {}),
	})
	const calls = () =>
		spawner.processes
			.flatMap((p) => p.toolCalls)
			.filter((c) => c.name !== 'set_agent_cursor_enabled')
	return { adapter, calls, processes: spawner.processes }
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
			full_output: true,
			include_screenshot: false,
			max_elements: 5000,
		})
		await adapter.dispose()
	})

	it('reads the window in front when no id is given', async () => {
		const { adapter, calls } = driver({})
		const snapshot = await adapter.uiSnapshot()
		expect(snapshot.windowId).toBe('0xec097c')
		expect(calls()[1]?.arguments).toMatchObject({
			pid: 58056,
			window_id: 15468924,
		})
		await adapter.dispose()
	})

	it('translates an opaque UI ref to its driver token for background actions', async () => {
		const { adapter, calls } = driver({})
		const snapshot = await adapter.uiSnapshot('0x261206')
		const five = refFor(snapshot, 'Beş', 'invoke')
		const system = refFor(snapshot, 'System', 'expand')
		expect(five).not.toBe('s00000002:30')
		await expect(adapter.uiAct('s00000002:30', 'invoke')).resolves.toMatchObject({ ok: false })
		await expect(adapter.uiAct(five, 'invoke')).resolves.toMatchObject({
			ok: true,
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
		})
		await expect(adapter.uiAct(system, 'expand')).resolves.toMatchObject({
			ok: true,
		})
		expect(calls().filter((call) => call.name === 'click')).toEqual([
			{
				name: 'click',
				arguments: { pid: 11432, element_token: 's00000002:30' },
			},
			{
				name: 'click',
				arguments: { pid: 11432, element_token: 's00000002:1' },
			},
		])
		await adapter.dispose()
	})

	it('keeps a ref across a newer snapshot and clicks with the newest handle', async () => {
		const { adapter, calls } = driver({})
		const first = await adapter.uiSnapshot('0x261206')
		const ref = refFor(first, 'Beş', 'invoke')
		const second = await adapter.uiSnapshot('0x261206')
		expect(refFor(second, 'Beş', 'invoke')).toBe(ref)
		const reads = calls().filter((call) => call.name === 'get_window_state').length
		await expect(adapter.uiAct(ref, 'invoke')).resolves.toMatchObject({
			ok: true,
		})
		// The ref was read a moment ago, so only the two reads that watch the window precede the click.
		const sent = calls()
		const clickAt = sent.findIndex((call) => call.name === 'click')
		expect(sent.slice(0, clickAt).filter((call) => call.name === 'get_window_state')).toHaveLength(
			reads + 2,
		)
		await adapter.dispose()
	})

	it('answers STALE_REF for a ref it was never given, without calling the driver', async () => {
		const { adapter, calls } = driver({})
		await adapter.uiSnapshot('0x261206')
		const before = calls().length
		await expect(adapter.uiAct('cua-ui:other:1', 'invoke')).resolves.toMatchObject({
			ok: false,
			code: 'STALE_REF',
			delivery: 'not_delivered',
			retrySafety: 'safe',
		})
		expect(calls()).toHaveLength(before)
		await adapter.dispose()
	})

	it('never falls back to typing when a field has no settable value', async () => {
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
		const snapshot = await adapter.uiSnapshot('0xec097c')
		const result = await adapter.uiAct(
			refFor(snapshot, 'Text Editor', 'set_value'),
			'set_value',
			'Merhaba',
		)
		expect(result).toMatchObject({
			ok: false,
			delivery: 'not_delivered',
			retrySafety: 'safe',
		})
		expect(result.detail).toMatch(/nothing was typed/)
		expect(calls().some((c) => c.name === 'type_text')).toBe(false)
		await adapter.dispose()
	})

	it('sets a classic edit control by window message and reports what it reads back', async () => {
		const sent: unknown[] = []
		const reading = { found: true, reason: '', done: true, len: 7, text: '', seen: 'Merhaba' }
		const foreground = {
			editText: async (request: unknown) => {
				sent.push(request)
				return reading
			},
		} as unknown as CuaDriverAdapterOptions['foreground']
		const { adapter, calls } = driver(
			{
				set_value: () => ({
					result: {
						isError: true,
						content: [
							{ type: 'text', text: 'set_value: element [0] does not implement ValuePattern.' },
						],
					},
				}),
			},
			{ foreground },
		)
		const snapshot = await adapter.uiSnapshot('0xec097c')
		const ref = refFor(snapshot, 'Text Editor', 'set_value')
		const result = await adapter.uiAct(ref, 'set_value', 'Merhaba')
		expect(result).toMatchObject({
			ok: true,
			delivery: 'delivered_verified',
			retrySafety: 'safe',
			readBack: { expected: 'Merhaba', observed: 'Merhaba' },
		})
		expect(sent).toMatchObject([{ hwnd: '0xec097c', op: 'set', text: 'Merhaba', pick: 'bounds' }])
		// Nothing was typed through the driver.
		expect(calls().some((c) => c.name === 'type_text')).toBe(false)
		// A program with higher rights refuses the message: that is not delivered, with the reason.
		Object.assign(reading, { found: false, reason: 'uipi', done: false, seen: '' })
		await expect(adapter.uiAct(ref, 'set_value', 'x')).resolves.toMatchObject({
			ok: false,
			delivery: 'not_delivered',
			retrySafety: 'safe',
		})
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
		const snapshot = await adapter.uiSnapshot('0x261206')
		const five = refFor(snapshot, 'Beş', 'invoke')
		await expect(adapter.uiAct(five, 'invoke')).resolves.toMatchObject({
			ok: false,
			delivery: 'not_delivered',
			retrySafety: 'safe',
			detail: 'that control is from an older UI snapshot; take a new one',
		})
		await expect(adapter.uiAct(five, 'invoke')).resolves.toMatchObject({
			ok: false,
			delivery: 'not_delivered',
			detail: 'the control is disabled',
		})
		// A suspected no-op is not done, but the input was sent: not safe to repeat.
		await expect(adapter.uiAct(five, 'invoke')).resolves.toMatchObject({
			ok: false,
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
		})
		await adapter.dispose()
	})

	it('revives an expired session without replaying an action through an old UI token', async () => {
		let expired = false
		const { adapter, calls } = driver({
			click: () =>
				expired
					? {
							result: {
								isError: true,
								content: [{ type: 'text', text: 'session ended before dispatch' }],
								structuredContent: {
									status: 'refused',
									refusal: {
										code: 'session_ended',
										message: 'session ended before dispatch',
									},
								},
							},
						}
					: toolResult({ effect: 'confirmed' }),
			start_session: () => {
				expired = false
				return toolResult({ active: true, revived: true })
			},
		})
		const beforeExpiry = await adapter.uiSnapshot('0x261206')
		const oldRef = refFor(beforeExpiry, 'Beş', 'invoke')
		expired = true
		// The refused click never ran. The control is found again in a new read of
		// the window under the revived session, and only then is it clicked.
		await expect(adapter.uiAct(oldRef, 'invoke')).resolves.toMatchObject({
			ok: true,
		})
		// Each attempt reads the window twice and lists its program's windows before it clicks (that is how its effect is judged),
		// and the control is found again by one more read after the revival.
		expect(calls().map((call) => call.name)).toEqual([
			'list_windows',
			'get_window_state',
			'get_window_state',
			'get_window_state',
			'list_windows',
			'click',
			'start_session',
			'get_window_state',
			'get_window_state',
			'get_window_state',
			'list_windows',
			'click',
		])
		const afterRevival = await adapter.uiSnapshot('0x261206')
		expect(refFor(afterRevival, 'Beş', 'invoke')).toBe(oldRef)
		await adapter.dispose()
	})

	it('refuses old refs across a driver restart even when the raw token is reused', async () => {
		const { adapter, calls, processes } = driver({
			get_window_state: (_call, process) =>
				toolResult(
					process.pid === 4242
						? CALCULATOR_STATE
						: {
								...CALCULATOR_STATE,
								elements: CALCULATOR_ELEMENTS.map((element) =>
									element.element_index === 30 ? { ...element, label: 'Delete all' } : element,
								),
								tree_markdown: CALCULATOR_MARKDOWN.replace('Button "Beş"', 'Button "Delete all"'),
							},
				),
		})
		const beforeCrash = await adapter.uiSnapshot('0x261206')
		const oldRef = refFor(beforeCrash, 'Beş', 'invoke')
		const firstProcess = processes[0]
		if (!firstProcess) throw new Error('driver did not start')
		const closed = new Promise<void>((resolve) => firstProcess.once('close', () => resolve()))
		firstProcess.crash(1)
		await closed

		// uiAct starts the replacement process, rejects the old token before any
		// click can reach it, reads the window again, and finds that the control
		// the id named now says something else: STALE_REF, nothing clicked.
		await expect(adapter.uiAct(oldRef, 'invoke')).resolves.toMatchObject({
			ok: false,
			code: 'STALE_REF',
			delivery: 'not_delivered',
			retrySafety: 'safe',
		})
		expect(processes).toHaveLength(2)
		expect(processes[1]?.toolCalls.map((call) => call.name)).toEqual([
			'set_agent_cursor_enabled',
			'get_window_state',
			'get_window_state',
			'list_windows',
			'get_window_state',
		])

		const afterCrash = await adapter.uiSnapshot('0x261206')
		const newRef = refFor(afterCrash, 'Delete all', 'invoke')
		expect(newRef).not.toBe(oldRef)
		await expect(adapter.uiAct(oldRef, 'invoke')).resolves.toMatchObject({
			ok: false,
		})
		await expect(adapter.uiAct(newRef, 'invoke')).resolves.toMatchObject({
			ok: true,
		})
		expect(calls().filter((call) => call.name === 'click')).toEqual([
			{
				name: 'click',
				arguments: { pid: 11432, element_token: 's00000002:30' },
			},
		])
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
		const snapshot = await host.uiSnapshot('0x261206')
		const result = await host.uiAct(refFor(snapshot, 'Beş', 'invoke'), 'invoke')
		expect(result.ok).toBe(false)
		expect(result.detail).toMatch(/may or may not have happened/)
		expect(result).toMatchObject({
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
		})
		await host.dispose()
	})
})
