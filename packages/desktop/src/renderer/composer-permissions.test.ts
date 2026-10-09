import { type ComponentProps, type ReactElement, type ReactNode, isValidElement } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import {
	type ComposerPermissionMode,
	ComposerPermissions,
	permissionMenuTitle,
	permissionRows,
} from './composer-permissions.js'

// Exercise the actual controlled callbacks and renders without substituting a
// policy reducer. Native checks cover Base UI keyboard, portals and focus.
const hooks = vi.hoisted(() => ({
	states: [] as unknown[],
	refs: [] as { current: unknown }[],
	stateIndex: 0,
	refIndex: 0,
	effects: [] as (() => void)[],
}))
vi.mock('react', async (original) => ({
	...(await original<typeof import('react')>()),
	useState(initial: unknown) {
		const index = hooks.stateIndex++
		if (!(index in hooks.states)) hooks.states[index] = initial
		return [
			hooks.states[index],
			(value: unknown) => {
				hooks.states[index] = value
			},
		]
	},
	useRef(initial: unknown) {
		const index = hooks.refIndex++
		hooks.refs[index] ??= { current: initial }
		return hooks.refs[index]
	},
	useEffect(effect: () => void) {
		hooks.effects.push(effect)
	},
}))
vi.mock('./ui/popover.js', () => ({
	Popover: 'popover',
	PopoverTrigger: 'trigger',
	PopoverPopup: 'popup',
	PopoverTitle: 'poptitle',
}))
vi.mock('./composer-control.js', () => ({ ComposerControl: 'button' }))
vi.mock('./ui/button.js', () => ({ Button: 'button' }))
vi.mock('@base-ui/react/alert-dialog', () => ({
	AlertDialog: {
		Root: 'alert-dialog',
		Portal: 'portal',
		Backdrop: 'backdrop',
		Viewport: 'viewport',
		Popup: 'alert-popup',
		Title: 'title',
		Description: 'description',
		Close: 'close',
	},
}))

type Props = ComponentProps<typeof ComposerPermissions>
type Node = ReactElement<Record<string, unknown>>
beforeEach(() => {
	hooks.states = []
	hooks.refs = []
	hooks.effects = []
})
function render(overrides: Partial<Props> = {}) {
	hooks.stateIndex = 0
	hooks.refIndex = 0
	hooks.effects = []
	const element = ComposerPermissions({
		permissionMode: 'prompt',
		disabled: false,
		onChange: vi.fn(),
		permissionScope: 'conversation-1',
		...overrides,
	})
	for (const effect of hooks.effects) effect()
	return element
}
function all(node: ReactNode, type: string): Node[] {
	if (Array.isArray(node)) return node.flatMap((entry) => all(entry, type))
	if (!isValidElement<Record<string, unknown>>(node)) return []
	return [...(node.type === type ? [node] : []), ...all(node.props.children as ReactNode, type)]
}
function one(node: ReactNode, type: string): Node {
	const found = all(node, type)[0]
	if (!found) throw new Error(`Missing ${type}`)
	return found
}
function rows(node: ReactNode) {
	return all(node, 'button').filter((entry) => entry.props.role === 'menuitemradio')
}
function choose(node: ReactNode, value: string) {
	const row = rows(node).find((entry) => entry.props.children && entryValue(entry) === value)
	if (!row) return
	;(row.props.onClick as () => void)()
}
function entryValue(entry: Node): string {
	// The row's label identifies it; map labels back to modes through the engine rows.
	const label = text(entry.props.children as ReactNode)
	for (const engine of ['namzu', 'codex-cli', 'claude-code'] as const)
		for (const row of permissionRows(
			engine,
			['prompt', 'accept-edits', 'auto', 'plan', 'strict'],
			'strict',
		))
			if (label.startsWith(row.label)) return row.value
	return ''
}
function confirm(node: ReactNode) {
	const button = all(node, 'button').find((entry) => entry.props.children === 'Enable full access')
	if (!button) throw new Error('Missing confirmation button')
	return button.props.onClick as () => void
}
function text(node: ReactNode): string {
	if (typeof node === 'string') return node
	if (Array.isArray(node)) return node.map(text).join('')
	return isValidElement<Record<string, unknown>>(node) ? text(node.props.children as ReactNode) : ''
}

const all5 = ['prompt', 'accept-edits', 'auto', 'plan', 'strict'] as const

it.each([
	['namzu', ['prompt', 'accept-edits', 'auto', 'plan']],
	['codex-cli', ['prompt', 'accept-edits', 'auto', 'plan']],
	['claude-code', ['prompt', 'plan']],
] as const)('lists only what %s supports, in menu order', (engine, expected) => {
	const supported: readonly ComposerPermissionMode[] =
		engine === 'claude-code' ? ['prompt', 'plan'] : all5
	expect(permissionRows(engine, supported, 'prompt').map((row) => row.value)).toEqual(expected)
})

it('reaches accept-edits whenever the engine supports it', () => {
	const view = render({ reviewModes: ['prompt', 'accept-edits', 'auto', 'plan'] })
	expect(rows(view).map(entryValue)).toContain('accept-edits')
	// Without explicit reviewModes (what the app passes for Namzu and Codex) it is still offered.
	expect(rows(render()).map(entryValue)).toContain('accept-edits')
	expect(rows(render({ engine: 'claude-code' })).map(entryValue)).not.toContain('accept-edits')
})

it('hides strict unless it is the saved mode, then shows it as preapproved only', () => {
	expect(permissionRows('namzu', all5, 'prompt').map((row) => row.value)).not.toContain('strict')
	const saved = permissionRows('namzu', all5, 'strict')
	expect(saved.at(-1)).toMatchObject({ value: 'strict', label: 'Preapproved only' })
})

it('titles plan as Read only for Codex and marks only Full access as a warning', () => {
	const codex = permissionRows('codex-cli', all5, 'prompt')
	expect(codex.find((row) => row.value === 'plan')?.label).toBe('Read only')
	expect(permissionRows('namzu', all5, 'prompt').find((row) => row.value === 'plan')?.label).toBe(
		'Plan only',
	)
	expect(codex.filter((row) => row.warning).map((row) => row.value)).toEqual(['auto'])
})

it('titles the menu with the engine name', () => {
	expect(permissionMenuTitle('codex-cli')).toBe('When should Codex check with you?')
	expect(permissionMenuTitle('claude-code')).toBe('When should Claude Code check with you?')
	expect(permissionMenuTitle('namzu')).toBe('When should Namzu check with you?')
})

it('names the chip by the current mode and flags Full access', () => {
	const view = render({ permissionMode: 'auto' })
	expect(one(view, 'trigger').props['aria-label']).toBe('Permissions: Full access')
	expect(one(view, 'trigger').props['data-composer-permission']).toBe('auto')
})

it('marks a saved mode the engine no longer supports and never changes it silently', () => {
	const onChange = vi.fn()
	const view = render({
		engine: 'claude-code',
		reviewModes: ['prompt', 'plan'],
		permissionMode: 'strict',
		onChange,
	})
	expect(rows(view).map(entryValue)).toEqual(['prompt', 'plan', 'strict'])
	choose(view, 'strict')
	expect(onChange).not.toHaveBeenCalled()
})

it('commits a choice by click once and ignores the current mode', () => {
	const onChange = vi.fn()
	const view = render({ onChange })
	choose(view, 'plan')
	choose(view, 'prompt')
	expect(onChange).toHaveBeenCalledExactlyOnceWith('plan')
})

it('requires explicit Codex full-access confirmation, focuses cancellation first, and applies once', () => {
	const onChange = vi.fn()
	const props: Partial<Props> = { engine: 'codex-cli', onChange }
	let view = render(props)
	choose(view, 'auto')
	expect(onChange).not.toHaveBeenCalled()
	view = render(props)
	expect(one(view, 'alert-dialog').props.open).toBe(true)
	expect(text(one(view, 'description'))).toContain('only to this conversation')
	expect(one(view, 'alert-popup').props.initialFocus).toBe(
		(one(view, 'close').props.render as Node).props.ref,
	)
	expect(one(view, 'alert-popup').props.finalFocus).toBe(one(view, 'trigger').props.ref)
	const apply = confirm(view)
	apply()
	apply()
	expect(onChange).toHaveBeenCalledExactlyOnceWith('auto')
	expect(one(render(props), 'alert-dialog').props.open).toBe(false)
})

it('asks once, with the consequences in words, before Namzu full access', () => {
	const onChange = vi.fn()
	const props: Partial<Props> = { engine: 'namzu', onChange }
	choose(render(props), 'auto')
	expect(onChange).not.toHaveBeenCalled()
	const view = render(props)
	expect(one(view, 'alert-dialog').props.open).toBe(true)
	expect(text(one(view, 'title'))).toBe('Allow Namzu full access?')
	expect(text(one(view, 'description'))).toContain('without asking you first')
	expect(text(one(view, 'description'))).toContain('only to this conversation')
	const apply = confirm(view)
	apply()
	apply()
	expect(onChange).toHaveBeenCalledExactlyOnceWith('auto')
})

it('dismisses full-access confirmation without policy selection', () => {
	const onChange = vi.fn()
	const props: Partial<Props> = { engine: 'codex-cli', onChange }
	choose(render(props), 'auto')
	;(one(render(props), 'close').props.onClick as () => void)()
	expect(one(render(props), 'alert-dialog').props.open).toBe(false)
	expect(onChange).not.toHaveBeenCalled()
})

it('does not prompt again for an already-selected Codex full access', () => {
	const onChange = vi.fn()
	const view = render({ engine: 'codex-cli', permissionMode: 'auto', onChange })
	choose(view, 'auto')
	expect(one(view, 'alert-dialog').props.open).toBe(false)
	expect(onChange).not.toHaveBeenCalled()
})

it.each([
	{ permissionScope: 'conversation-2' },
	{ engine: 'namzu' as const },
	{ permissionMode: 'plan' as const },
	{ disabled: true },
	{ reviewModes: ['prompt', 'plan'] as const },
])('refuses a stale confirmation after current conversation authority changes: %j', (changed) => {
	const onChange = vi.fn()
	const props: Partial<Props> = { engine: 'codex-cli', onChange }
	choose(render(props), 'auto')
	const staleConfirm = confirm(render(props))
	expect(one(render({ ...props, ...changed }), 'alert-dialog').props.open).toBe(false)
	staleConfirm()
	expect(onChange).not.toHaveBeenCalled()
	expect(one(render(props), 'alert-dialog').props.open).toBe(false)
})

it('refuses a disabled selection without opening confirmation', () => {
	const onChange = vi.fn()
	choose(render({ engine: 'codex-cli', disabled: true, onChange }), 'auto')
	expect(
		one(render({ engine: 'codex-cli', disabled: true, onChange }), 'alert-dialog').props.open,
	).toBe(false)
	expect(onChange).not.toHaveBeenCalled()
})
