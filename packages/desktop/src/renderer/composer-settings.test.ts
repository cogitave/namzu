import { type ComponentProps, type ReactElement, type ReactNode, isValidElement } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ComposerPermissions } from './composer-settings.js'

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
vi.mock('./ui/select.js', () => ({
	Select: 'select',
	SelectTrigger: 'trigger',
	SelectPopup: 'popup',
	SelectItem: 'option',
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
function choose(node: ReactNode, value: string) {
	;(one(node, 'select').props.onValueChange as (value: string) => void)(value)
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

it('offers three Namzu policies, retains configured-rule wording and never changes policy on menu open', () => {
	const onChange = vi.fn()
	const view = render({ onChange })
	expect(all(view, 'option').map((option) => option.props.value)).toEqual([
		'prompt',
		'auto',
		'plan',
	])
	expect(text(all(view, 'option'))).toContain('within your configured rules')
	expect(text(all(view, 'option'))).not.toContain('Approve for me')
	const openChange = one(view, 'alert-dialog').props.onOpenChange as (open: boolean) => void
	openChange(true)
	expect(onChange).not.toHaveBeenCalled()
	choose(view, 'auto')
	expect(onChange).toHaveBeenCalledExactlyOnceWith('auto')
})

it.each([
	['accept-edits', 'Allow edits'],
	['strict', 'Preapproved only'],
] as const)(
	'preserves the selected legacy %s policy without offering the other legacy mode',
	(permissionMode, label) => {
		const onChange = vi.fn()
		const view = render({
			permissionMode,
			onChange,
			reviewModes: ['prompt', 'auto', 'plan', 'accept-edits', 'strict'],
		})
		expect(all(view, 'option').map((option) => option.props.value)).toHaveLength(4)
		expect(one(view, 'select').props.value).toBe(permissionMode)
		expect(text(one(view, 'trigger'))).toContain(label)
		expect(onChange).not.toHaveBeenCalled()
	},
)

it('honors supplied Claude modes and keeps an unsupported saved policy visible without silently changing it', () => {
	const onChange = vi.fn()
	let view = render({ engine: 'claude-code', reviewModes: ['prompt', 'plan'], onChange })
	expect(all(view, 'option').map((option) => option.props.value)).toEqual(['prompt', 'plan'])
	choose(view, 'auto')
	expect(onChange).not.toHaveBeenCalled()
	view = render({
		engine: 'claude-code',
		reviewModes: ['prompt', 'plan'],
		permissionMode: 'strict',
		onChange,
	})
	expect(one(view, 'select').props.value).toBe('strict')
	expect(
		all(view, 'option').find((option) => option.props.value === 'strict')?.props.disabled,
	).toBe(true)
	expect(onChange).not.toHaveBeenCalled()
})

it('requires explicit Codex full-access confirmation, focuses cancellation first, and applies once', () => {
	const onChange = vi.fn()
	const props: Partial<Props> = { engine: 'codex-cli', onChange }
	let view = render(props)
	expect(text(all(view, 'option'))).toContain('Full access')
	expect(text(all(view, 'option'))).toContain('across this computer')
	expect(text(all(view, 'option'))).not.toContain('Allow tools')
	choose(view, 'auto')
	expect(onChange).not.toHaveBeenCalled()
	view = render(props)
	expect(one(view, 'alert-dialog').props.open).toBe(true)
	expect(one(view, 'select').props.value).toBe('prompt')
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

it('dismisses full-access confirmation without policy selection', () => {
	const onChange = vi.fn()
	const props: Partial<Props> = { engine: 'codex-cli', onChange }
	choose(render(props), 'auto')
	const view = render(props)
	const cancel = one(view, 'close').props.onClick as () => void
	cancel()
	expect(one(render(props), 'alert-dialog').props.open).toBe(false)
	expect(onChange).not.toHaveBeenCalled()
})

it('restores an already-selected Codex full-access policy without prompting or reselecting it', () => {
	const onChange = vi.fn()
	const view = render({ engine: 'codex-cli', permissionMode: 'auto', onChange })
	expect(text(one(view, 'trigger'))).toContain('Full access')
	expect(one(view, 'alert-dialog').props.open).toBe(false)
	choose(view, 'auto')
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

it('refuses disabled and unsupported selection callbacks without opening confirmation', () => {
	const onChange = vi.fn()
	const disabled = render({ engine: 'codex-cli', disabled: true, onChange })
	choose(disabled, 'auto')
	expect(
		one(render({ engine: 'codex-cli', disabled: true, onChange }), 'alert-dialog').props.open,
	).toBe(false)
	expect(onChange).not.toHaveBeenCalled()
})
