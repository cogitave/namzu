import { type ComponentProps, type ReactElement, type ReactNode, isValidElement } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ComposerEffort } from './composer-settings.js'

// Call the actual controlled effort handlers with deterministic model/owner
// changes. Native checks cover Base UI nesting, keyboard and portal focus.
const hooks = vi.hoisted(() => ({
	refs: [] as { current: unknown }[],
	index: 0,
	setups: [] as (() => undefined | (() => void))[],
	narrow: false,
}))
vi.mock('react', async (original) => ({
	...(await original<typeof import('react')>()),
	useRef(initial: unknown) {
		const index = hooks.index++
		hooks.refs[index] ??= { current: initial }
		return hooks.refs[index]
	},
	useEffect(setup: () => undefined | (() => void)) {
		hooks.setups.push(setup)
	},
	useState(initial: unknown) {
		return [typeof initial === 'boolean' ? hooks.narrow : initial, vi.fn()]
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
vi.mock('./ui/popover.js', () => ({
	Popover: 'popover',
	PopoverTrigger: 'trigger',
	PopoverPopup: 'popup',
}))

type Props = ComponentProps<typeof ComposerEffort>
type Node = ReactElement<Record<string, unknown>>
beforeEach(() => {
	hooks.refs = []
	hooks.index = 0
	hooks.setups = []
	hooks.narrow = false
})
function render(overrides: Partial<Props> = {}) {
	hooks.index = 0
	hooks.setups = []
	return ComposerEffort({
		scope: 'project:session:provider:model-a',
		effortLevels: ['low', 'high'],
		effortDefault: 'low',
		disabled: false,
		onChange: vi.fn(),
		...overrides,
	})
}
function all(node: ReactNode, type: string): Node[] {
	if (Array.isArray(node)) return node.flatMap((child) => all(child, type))
	if (!isValidElement<Record<string, unknown>>(node)) return []
	return [...(node.type === type ? [node] : []), ...all(node.props.children as ReactNode, type)]
}
function one(node: ReactNode, type: string): Node {
	const result = all(node, type)[0]
	if (!result) throw new Error(`Missing ${type}`)
	return result
}
function choose(node: ReactNode): (value: string) => void {
	const change = one(node, 'input').props.onChange as (event: {
		currentTarget: { value: string }
	}) => void
	return (value) => change({ currentTarget: { value } })
}
function reset(node: ReactNode): () => void {
	const button = all(node, 'button').find(
		(entry) => entry.props['aria-label'] === 'Use model default effort',
	)
	if (!button) throw new Error('Missing default effort button')
	return button.props.onClick as () => void
}
function text(node: ReactNode): string {
	if (typeof node === 'string') return node
	if (Array.isArray(node)) return node.map(text).join('')
	return isValidElement<Record<string, unknown>>(node) ? text(node.props.children as ReactNode) : ''
}

it('uses only actual model effort metadata and changes no value while opening or rendering', () => {
	const onChange = vi.fn()
	const view = render({ effortLevels: ['none', 'high'], effortDefault: 'high', onChange })
	expect(one(view, 'input').props).toMatchObject({
		type: 'range',
		min: 0,
		max: 1,
		step: 1,
		value: 1,
		'aria-valuetext': 'High',
	})
	expect(text(one(view, 'trigger'))).toBe('High')
	expect(text(view)).toContain('FasterSmarter')
	expect(onChange).not.toHaveBeenCalled()
	choose(view)('1')
	reset(render({ effort: 'high', onChange }))()
	choose(view)('2')
	expect(onChange.mock.calls).toEqual([['high'], [undefined]])
})

it('does not invent an effort default or a control when metadata is absent', () => {
	expect(text(one(render({ effortDefault: undefined }), 'trigger'))).toBe('Provider default')
	expect(text(one(render({ effortDefault: 'ultra' }), 'trigger'))).toBe('Provider default')
	expect(all(render({ effortDefault: undefined }), 'input')).toHaveLength(0)
	expect(all(render({ effortLevels: undefined }), 'trigger')).toHaveLength(0)
	expect(all(render({ effortLevels: [] }), 'trigger')).toHaveLength(0)
	const onChange = vi.fn()
	const view = render({ effortDefault: undefined, onChange })
	const choices = all(view, 'button').filter(
		(entry) => entry.props['aria-label'] !== 'Use model default effort',
	)
	expect(choices.map(text)).toEqual(['Low', 'High'])
	expect(onChange).not.toHaveBeenCalled()
	;(choices[1]?.props.onClick as () => void)()
	expect(onChange).toHaveBeenCalledExactlyOnceWith('high')
})

it('keeps an unsupported saved effort explicit and resets it only on the user action', () => {
	const onChange = vi.fn()
	const view = render({ effort: 'max', effortLevels: undefined, onChange })
	expect(text(view)).toContain('Reset Max')
	expect(all(view, 'input')).toHaveLength(0)
	expect(onChange).not.toHaveBeenCalled()
	;(one(view, 'button').props.onClick as () => void)()
	expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined)
})

it('rejects retained effort callbacks after a model or conversation change, including returning to the old model', () => {
	const onChange = vi.fn()
	const stale = choose(render({ onChange }))
	const staleReset = reset(render({ effort: 'high', onChange }))
	render({ scope: 'project:session:provider:model-b', onChange })
	stale('1')
	staleReset()
	render({ onChange })
	stale('1')
	staleReset()
	render({ scope: 'project:other-session:provider:model-a', onChange })
	stale('1')
	expect(onChange).not.toHaveBeenCalled()
	choose(render({ onChange }))('0')
	expect(onChange).toHaveBeenCalledExactlyOnceWith('low')
})

it('rechecks current capabilities and busy state before admitting a retained callback', () => {
	const onChange = vi.fn()
	const stale = choose(render({ onChange }))
	const staleReset = reset(render({ effort: 'high', onChange }))
	render({ effortLevels: ['low'], onChange })
	stale('1')
	render({ disabled: true, onChange })
	stale('0')
	staleReset()
	expect(onChange).not.toHaveBeenCalled()
	choose(render({ onChange }))('0')
	expect(onChange).toHaveBeenCalledExactlyOnceWith('low')
})

it('uses the latest controlled settings callback for the same admitted owner and model', () => {
	const previous = vi.fn()
	const current = vi.fn()
	const retained = choose(render({ onChange: previous }))
	render({ onChange: current })
	retained('1')
	expect(previous).not.toHaveBeenCalled()
	expect(current).toHaveBeenCalledExactlyOnceWith('high')
})

it('rejects reset and select callbacks after unmount while supporting Strict Mode effect restart', () => {
	const onChange = vi.fn()
	const select = choose(render({ onChange }))
	const setup = hooks.setups[0]
	if (!setup) throw new Error('Missing mount effect')
	const cleanup = setup()
	if (!cleanup) throw new Error('Missing cleanup')
	cleanup()
	select('1')
	select('0')
	expect(onChange).not.toHaveBeenCalled()
	setup()
	select('1')
	expect(onChange).toHaveBeenCalledExactlyOnceWith('high')
	const reset = one(render({ effort: 'max', effortLevels: undefined, onChange }), 'button').props
		.onClick as () => void
	cleanup()
	reset()
	expect(onChange).toHaveBeenCalledTimes(1)
})

it('maps only the actual supported subset to canonical Faster–Smarter discrete stops', () => {
	const onChange = vi.fn()
	const view = render({
		effortLevels: ['ultra', 'high', 'low', 'low'],
		effort: 'high',
		onChange,
	})
	expect(one(view, 'input').props).toMatchObject({ min: 0, max: 2, step: 1, value: 1 })
	expect(all(view, 'i')).toHaveLength(3)
	const change = choose(view)
	for (const value of ['0', '1', '2']) change(value)
	for (const invalid of ['-1', '3', '0.5', '', ' ', 'NaN', 'Infinity']) change(invalid)
	expect(onChange.mock.calls).toEqual([['low'], ['high'], ['ultra']])
})

it('keeps range and effort-chip navigation out of the model radio group while retaining native keys and Escape', () => {
	const view = render()
	const panel = all(view, 'div').find(
		(node) => node.props.className === 'model-picker-effort-panel',
	)
	if (!panel) throw new Error('Missing effort panel')
	for (const node of [one(view, 'trigger'), panel]) {
		const handler = node.props.onKeyDown as (event: {
			key: string
			stopPropagation: () => void
			preventDefault: () => void
		}) => void
		for (const key of [
			'ArrowLeft',
			'ArrowRight',
			'ArrowUp',
			'ArrowDown',
			'Home',
			'End',
			'PageUp',
			'PageDown',
			'/',
		]) {
			const event = { key, stopPropagation: vi.fn(), preventDefault: vi.fn() }
			handler(event)
			expect(event.stopPropagation).toHaveBeenCalledOnce()
			expect(event.preventDefault).not.toHaveBeenCalled()
		}
		for (const key of ['Escape', 'Enter', ' ', 'Tab']) {
			const event = { key, stopPropagation: vi.fn(), preventDefault: vi.fn() }
			handler(event)
			expect(event.stopPropagation).not.toHaveBeenCalled()
			expect(event.preventDefault).not.toHaveBeenCalled()
		}
	}
})

it('anchors side placement to the whole selected row so left and right collision use its outer edges', () => {
	const view = render()
	const row = {} as HTMLDivElement
	const closest = vi.fn(() => row as Element | null)
	const button = { closest } as unknown as HTMLButtonElement
	const ref = one(view, 'trigger').props.ref as { current: HTMLButtonElement | null }
	const popup = one(view, 'popup')
	const anchor = popup.props.anchor as () => Element | null
	ref.current = button
	expect(popup.props).toMatchObject({ side: 'right', align: 'start' })
	expect(anchor()).toBe(row)
	expect(closest).toHaveBeenCalledExactlyOnceWith('.model-picker-row-wrap')
	closest.mockReturnValue(null)
	expect(anchor()).toBe(button)
	ref.current = null
	expect(anchor()).toBeNull()
})

it('keeps narrow bottom placement aligned to the effort chip rather than the full row', () => {
	hooks.narrow = true
	const view = render()
	const closest = vi.fn()
	const button = { closest } as unknown as HTMLButtonElement
	const ref = one(view, 'trigger').props.ref as { current: HTMLButtonElement | null }
	ref.current = button
	const popup = one(view, 'popup')
	expect(popup.props).toMatchObject({ side: 'bottom', align: 'end' })
	expect((popup.props.anchor as () => Element | null)()).toBe(button)
	expect(closest).not.toHaveBeenCalled()
})
