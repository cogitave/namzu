/**
 * What the adapter claims about an action's effect. The driver reports
 * `effect: "unverifiable"` for nearly everything it does in the background,
 * so a stateful action is judged by reading the control back, and nothing
 * that is refused or unknown is turned into a success.
 */
import { describe, expect, it } from 'vitest'
import { CuaDriverAdapter } from '../adapters/cua-driver/adapter.js'
import {
	actResult,
	failureDelivery,
	inputDelivery,
	judgeSelect,
	judgeSetValue,
	judgeToggle,
} from '../adapters/cua-driver/adapter.js'
import { McpToolError } from '../adapters/cua-driver/client.js'
import {
	type FakeServerScript,
	type ToolCall,
	fakeSpawner,
	toolResult,
} from './fake-mcp-process.js'

/** A driver answer as the client hands it to the adapter. */
const answer = (facts: Record<string, unknown>) => ({ content: [], structuredContent: facts })

interface Control {
	index: number
	role: string
	label: string
	value?: string
	selected?: boolean
	actions: string[]
	id?: string
}

/** A page whose controls the test can change between reads. */
function page(initial: Control[]) {
	const controls = initial.map((control) => ({ ...control }))
	const calls: ToolCall[] = []
	let reads = 0
	const script: FakeServerScript = {
		tool: (call) => {
			calls.push(call)
			switch (call.name) {
				case 'list_windows':
					return toolResult({
						windows: [
							{
								window_id: 100,
								pid: 7,
								app_name: 'page.exe',
								title: 'Form',
								bounds: { x: 0, y: 0, width: 800, height: 600 },
								z_index: 1,
							},
						],
					})
				case 'get_window_state': {
					reads += 1
					return toolResult({
						window_title: 'Form',
						app_name: 'page.exe',
						elements: controls.map((control) => ({
							element_index: control.index,
							// A new token on every read, as the driver issues them.
							element_token: `r${reads}:${control.index}`,
							role: control.role,
							label: control.label,
							...(control.value !== undefined ? { value: control.value } : {}),
							...(control.selected ? { selected: true } : {}),
							enabled: true,
							actions: control.actions,
						})),
					})
				}
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
	return { adapter, controls, calls, reads: () => reads }
}

const FORM: Control[] = [
	{ index: 0, role: 'Edit', label: 'Name', value: '', actions: ['set_value'] },
	{ index: 1, role: 'CheckBox', label: 'Agree', actions: ['toggle'] },
	{ index: 2, role: 'ComboBox', label: 'Colour', value: 'red', actions: ['set_value'] },
	{ index: 3, role: 'ListItem', label: 'beta.txt', actions: ['select', 'invoke'] },
]

function refOf(
	snapshot: Awaited<ReturnType<CuaDriverAdapter['uiSnapshot']>>,
	role: string,
	name: string,
) {
	const found: string[] = []
	const walk = (e: typeof snapshot.root): void => {
		if (e.ref && e.role === role && e.name === name) found.push(e.ref)
		for (const c of e.children ?? []) walk(c)
	}
	walk(snapshot.root)
	if (!found[0]) throw new Error(`no ${role} ${name}`)
	return found[0]
}

describe('set_value read-back', () => {
	it('is verified when the field reads back the value', async () => {
		const { adapter, controls } = page(FORM)
		const snapshot = await adapter.uiSnapshot('0x64')
		const ref = refOf(snapshot, 'Edit', 'Name')
		controls[0]!.value = 'Ada'
		await expect(adapter.uiAct(ref, 'set_value', 'Ada')).resolves.toMatchObject({
			ok: true,
			delivery: 'delivered_verified',
			retrySafety: 'safe',
			readBack: { expected: 'Ada', observed: 'Ada' },
		})
		await adapter.dispose()
	})

	it('is not delivered when the driver said ok and the field did not change', async () => {
		const { adapter } = page(FORM)
		const snapshot = await adapter.uiSnapshot('0x64')
		const result = await adapter.uiAct(refOf(snapshot, 'ComboBox', 'Colour'), 'set_value', 'blue')
		expect(result).toMatchObject({
			ok: false,
			delivery: 'not_delivered',
			retrySafety: 'safe',
			readBack: { expected: 'blue', observed: 'red' },
		})
		expect(result.detail).toMatch(/still holds "red"/)
		await adapter.dispose()
	})

	it('is unverified, not failed, when the field changed to something else', async () => {
		const { adapter, controls } = page(FORM)
		const snapshot = await adapter.uiSnapshot('0x64')
		const ref = refOf(snapshot, 'Edit', 'Name')
		controls[0]!.value = 'ADA'
		await expect(adapter.uiAct(ref, 'set_value', 'Ada!')).resolves.toMatchObject({
			ok: true,
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
		})
		await adapter.dispose()
	})

	it('is unverified when the control reports no value to read back', async () => {
		const { adapter, controls } = page([
			{ index: 0, role: 'Edit', label: 'Note', actions: ['set_value'] },
		])
		const snapshot = await adapter.uiSnapshot('0x64')
		const ref = refOf(snapshot, 'Edit', 'Note')
		expect(controls).toHaveLength(1)
		await expect(adapter.uiAct(ref, 'set_value', 'x')).resolves.toMatchObject({
			ok: true,
			delivery: 'delivered_unverified',
		})
		await adapter.dispose()
	})

	it('is unverified, never not delivered, when the read-back itself fails', async () => {
		const { adapter } = page(FORM)
		const snapshot = await adapter.uiSnapshot('0x64')
		const ref = refOf(snapshot, 'Edit', 'Name')
		// The next read of the window finds nothing: the control is gone.
		;(adapter as unknown as { findAgain: () => undefined }).findAgain = () => undefined
		await expect(adapter.uiAct(ref, 'set_value', 'Ada')).resolves.toMatchObject({
			ok: true,
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
		})
		await adapter.dispose()
	})

	it('keeps every ref of the window valid after a read-back', async () => {
		const { adapter, controls, calls } = page(FORM)
		const snapshot = await adapter.uiSnapshot('0x64')
		const name = refOf(snapshot, 'Edit', 'Name')
		const agree = refOf(snapshot, 'CheckBox', 'Agree')
		controls[0]!.value = 'Ada'
		await adapter.uiAct(name, 'set_value', 'Ada')
		controls[1]!.selected = true
		await expect(adapter.uiAct(agree, 'toggle')).resolves.toMatchObject({
			ok: true,
			delivery: 'delivered_verified',
		})
		// The click used the token of the newest read, not the stale first one.
		const click = calls.filter((call) => call.name === 'click').at(-1)
		expect(click?.arguments).toMatchObject({ element_token: 'r2:1' })
		await adapter.dispose()
	})
})

describe('toggle and select read-back', () => {
	it('verifies a toggle when the state flipped', async () => {
		const { adapter, controls } = page(FORM)
		const snapshot = await adapter.uiSnapshot('0x64')
		const ref = refOf(snapshot, 'CheckBox', 'Agree')
		controls[1]!.selected = true
		await expect(adapter.uiAct(ref, 'toggle')).resolves.toMatchObject({
			delivery: 'delivered_verified',
			retrySafety: 'unsafe',
		})
		await adapter.dispose()
	})

	it('does not call an unchanged toggle a failure, and warns that a repeat could undo it', async () => {
		const { adapter } = page(FORM)
		const snapshot = await adapter.uiSnapshot('0x64')
		const result = await adapter.uiAct(refOf(snapshot, 'CheckBox', 'Agree'), 'toggle')
		expect(result).toMatchObject({
			ok: true,
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
		})
		expect(result.detail).toMatch(/undo/)
		await adapter.dispose()
	})

	it('warns that selecting a list row also invokes it', async () => {
		const { adapter, controls } = page(FORM)
		const snapshot = await adapter.uiSnapshot('0x64')
		const ref = refOf(snapshot, 'ListItem', 'beta.txt')
		controls[3]!.selected = true
		const result = await adapter.uiAct(ref, 'select')
		expect(result).toMatchObject({ delivery: 'delivered_verified', retrySafety: 'unsafe' })
		expect(result.detail).toMatch(/opened the item/)
		await adapter.dispose()
	})
})

describe('driver answers', () => {
	it('only a confirmed effect is verified', () => {
		expect(inputDelivery(answer({ effect: 'confirmed' }))).toMatchObject({
			delivery: 'delivered_verified',
		})
		expect(inputDelivery(answer({ effect: 'unverifiable' }))).toMatchObject({
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
		})
		expect(inputDelivery(answer({ effect: 'refused' }))).toMatchObject({
			delivery: 'not_delivered',
			retrySafety: 'safe',
		})
	})

	it('a delivery_failed escalation is unverified, not success and not failure', () => {
		const result = inputDelivery(
			answer({
				effect: 'unverifiable',
				escalation: { reason: 'delivery_failed', target: 'foreground' },
			}),
		)
		expect(result).toMatchObject({ delivery: 'delivered_unverified', retrySafety: 'unsafe' })
		expect(result.detail).toMatch(/could not confirm/)
		expect(result.detail).toMatch(/delivery_mode:"foreground"/)
	})

	it('a suspected no-op is not ok but is unsafe to repeat', () => {
		expect(actResult(answer({ effect: 'suspected_noop' }))).toMatchObject({
			ok: false,
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
		})
	})

	it('a refusal before injection is safe to repeat; background codes name what to do', () => {
		const unavailable = failureDelivery(
			new McpToolError('type_text', 'background_unavailable', {
				code: 'background_unavailable',
			}),
		)
		expect(unavailable).toMatchObject({ delivery: 'not_delivered', retrySafety: 'safe' })
		expect(unavailable.detail).toMatch(/delivery_mode:"foreground"/)
		const blocked = failureDelivery(
			new McpToolError('click', 'blocked', { code: 'background_uipi_blocked' }),
		)
		expect(blocked.detail).toMatch(/do not try to get around/)
		expect(
			failureDelivery(
				new McpToolError('invoke_menu', 'refused', {
					status: 'refused',
					refusal: { code: 'menu_path_unavailable', message: 'no such menu path' },
				}),
			),
		).toMatchObject({ delivery: 'not_delivered', detail: 'no such menu path' })
	})

	it('an error the driver does not classify may have sent the input, so it is unsafe to repeat', () => {
		expect(failureDelivery(new McpToolError('type_text', 'something broke', {}))).toMatchObject({
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
		})
	})

	it('judges are pure over the facts they are given', () => {
		const field = { role: 'Edit', name: 'n', value: 'a', selected: false, actions: [] as never[] }
		expect(judgeSetValue(field, 'b', { ...field, value: 'b' }).delivery).toBe('delivered_verified')
		expect(judgeToggle(field, { ...field, selected: true }).delivery).toBe('delivered_verified')
		expect(judgeSelect(field, { ...field, selected: true }).delivery).toBe('delivered_verified')
		expect(judgeSelect(field, undefined).delivery).toBe('delivered_unverified')
	})
})
