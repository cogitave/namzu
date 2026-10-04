import { describe, expect, it, vi } from 'vitest'
import { createComputerChatMotion } from './computer-chat-motion.js'

type Box = { left: number; top: number; width: number; height: number }
type Painted = Box & { opacity: number; radius: number }

class Effect {
	id = ''
	cancel = vi.fn()
	private listeners: (() => void)[] = []
	constructor(
		readonly frames: Keyframe[],
		readonly options: KeyframeAnimationOptions,
	) {}
	addEventListener(_event: string, listener: () => void) {
		this.listeners.push(listener)
	}
	finish() {
		// A finish event can already be queued when an effect is cancelled.
		for (const listener of this.listeners) listener()
	}
}

function fixture(reduced = false) {
	let layout: 'hidden' | 'floating' | 'split' = 'hidden'
	let painted: Painted | null = null
	let headingPaint: { height: number; opacity: number } | null = null
	const makeStyle = () => {
		const style: Record<string, string | ((property: string) => void)> = {}
		style.removeProperty = (property: string) => {
			const key = property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
			delete style[key]
		}
		return style
	}
	const parentBox = { left: 100, top: 50, width: 1000, height: 800 }
	const bubbleBox = { left: 1052, top: 802, width: 32, height: 32 }
	const floatingBox = { left: 522, top: 184, width: 560, height: 650 }
	const splitBox = { left: 100, top: 98, width: 620, height: 752 }
	const emptyBox = { left: 0, top: 0, width: 0, height: 0 }
	const effects: { frame: Effect[]; lane: Effect[]; heading: Effect[] } = {
		frame: [],
		lane: [],
		heading: [],
	}
	const animation = (kind: keyof typeof effects) =>
		vi.fn((frames: Keyframe[], options: KeyframeAnimationOptions) => {
			const effect = new Effect(frames, options)
			effects[kind].push(effect)
			return effect
		})
	const lane = { style: makeStyle(), animate: animation('lane') }
	const heading = {
		style: makeStyle(),
		animate: animation('heading'),
		getBoundingClientRect: () => ({
			...emptyBox,
			height:
				headingPaint?.height ??
				Number.parseFloat(String(heading.style.height ?? (layout === 'floating' ? '44' : '0'))),
		}),
	}
	const mediaListeners = new Set<() => void>()
	const media = {
		matches: reduced,
		addEventListener: vi.fn((_event: string, listener: () => void) => mediaListeners.add(listener)),
		removeEventListener: vi.fn((_event: string, listener: () => void) =>
			mediaListeners.delete(listener),
		),
	}
	const view = {
		matchMedia: vi.fn(() => media),
		getComputedStyle: (node: unknown) => {
			const element = node as { style: Record<string, unknown> }
			return {
				opacity:
					node === stage && painted
						? String(painted.opacity)
						: node === heading && headingPaint
							? String(headingPaint.opacity)
							: String(element.style.opacity ?? '1'),
				borderRadius:
					node === stage && painted
						? `${painted.radius}px`
						: String(element.style.borderRadius ?? (layout === 'floating' ? '22px' : '0px')),
			}
		},
	}
	const stage = {
		ownerDocument: { defaultView: view },
		style: makeStyle(),
		dataset: {} as Record<string, string>,
		animate: animation('frame'),
		parentElement: {
			clientLeft: 0,
			clientTop: 0,
			getBoundingClientRect: () => parentBox,
			querySelector: () => ({ getBoundingClientRect: () => bubbleBox }),
		},
		getBoundingClientRect: () =>
			painted ?? (layout === 'floating' ? floatingBox : layout === 'split' ? splitBox : emptyBox),
		querySelector: (selector: string) =>
			selector === '.conversation-lane'
				? lane
				: selector === '.computer-floating-chat-heading'
					? heading
					: null,
	}
	const onHidden = vi.fn()
	const motion = createComputerChatMotion(stage as unknown as HTMLElement, onHidden)
	motion.update({ layout: 'hidden', rendered: false, visible: false })
	return {
		motion,
		stage,
		lane,
		heading,
		effects,
		onHidden,
		media,
		bubbleBox,
		parentBox,
		floatingBox,
		splitBox,
		layout(next: typeof layout) {
			layout = next
		},
		paint(frame: Painted, header?: { height: number; opacity: number }) {
			painted = frame
			headingPaint = header ?? null
		},
		clearPaint() {
			painted = null
			headingPaint = null
		},
		reduce() {
			media.matches = true
			for (const listener of mediaListeners) listener()
		},
	}
}

function open(f: ReturnType<typeof fixture>) {
	f.motion.capture()
	f.layout('floating')
	f.motion.update({ layout: 'floating', rendered: true, visible: true })
	return f.effects.frame.at(-1)!
}

describe('persistent computer chat motion', () => {
	it('expands the actual launcher frame and reveals content without scaling text', () => {
		const f = fixture()
		const effect = open(f)
		expect(effect.id).toBe('namzu-computer-chat-frame')
		expect(effect.frames).toEqual([
			{
				left: '952px',
				top: '752px',
				width: '32px',
				height: '32px',
				opacity: 0,
				borderRadius: '20px',
			},
			{
				left: '422px',
				top: '134px',
				width: '560px',
				height: '650px',
				opacity: 1,
				borderRadius: '22px',
			},
		])
		expect(effect.options).toMatchObject({ duration: 260, fill: 'both' })
		expect(f.effects.lane[0].options).toMatchObject({ delay: 70, duration: 150 })
		for (const kind of Object.values(f.effects))
			for (const animation of kind)
				for (const frame of animation.frames) expect(frame).not.toHaveProperty('transform')
		expect(f.stage.dataset.chatMotion).toBe('entering')
		effect.finish()
		expect(f.stage.style.position).toBeUndefined()
		expect(f.stage.dataset.chatMotion).toBeUndefined()
		expect(f.onHidden).not.toHaveBeenCalled()
	})

	it('finishes shrinking to the launcher before releasing the retained visible layout', () => {
		const f = fixture()
		open(f).finish()
		f.motion.capture()
		f.motion.update({ layout: 'floating', rendered: true, visible: false })
		const close = f.effects.frame.at(-1)!
		expect(close.frames[0]).toMatchObject({ width: '560px', height: '650px', opacity: 1 })
		expect(close.frames[1]).toMatchObject({ width: '32px', height: '32px', opacity: 0 })
		expect(f.onHidden).not.toHaveBeenCalled()
		close.finish()
		expect(f.onHidden).toHaveBeenCalledOnce()
		expect(f.stage.style.opacity).toBe('0')
		expect(f.stage.style.position).toBe('absolute')
		f.layout('hidden')
		f.motion.update({ layout: 'hidden', rendered: false, visible: false })
		expect(f.stage.style.opacity).toBeUndefined()
		expect(f.stage.style.position).toBeUndefined()
		expect(f.lane.style.opacity).toBeUndefined()
	})

	it('reverses a closing frame from its real intermediate bounds and ignores obsolete finishes', () => {
		const f = fixture()
		open(f).finish()
		f.motion.capture()
		f.motion.update({ layout: 'floating', rendered: true, visible: false })
		const closing = f.effects.frame.at(-1)!
		f.paint({ left: 790, top: 508, width: 292, height: 326, opacity: 0.54, radius: 21 })
		f.motion.capture()
		f.clearPaint()
		f.motion.update({ layout: 'floating', rendered: true, visible: true })
		const restoring = f.effects.frame.at(-1)!
		expect(closing.cancel).toHaveBeenCalledOnce()
		expect(restoring.frames[0]).toEqual({
			left: '690px',
			top: '458px',
			width: '292px',
			height: '326px',
			opacity: 0.54,
			borderRadius: '21px',
		})
		closing.finish()
		expect(f.onHidden).not.toHaveBeenCalled()
		expect(f.stage.dataset.chatMotion).toBe('entering')
		restoring.finish()
		expect(f.stage.style.position).toBeUndefined()
	})

	it('docks an interrupted floating frame into the measured split panel and retires its header', () => {
		const f = fixture()
		const opening = open(f)
		f.paint(
			{ left: 650, top: 320, width: 432, height: 514, opacity: 0.8, radius: 21 },
			{ height: 30, opacity: 0.7 },
		)
		f.motion.capture()
		f.clearPaint()
		f.layout('split')
		f.motion.update({ layout: 'split', rendered: true, visible: true })
		const dock = f.effects.frame.at(-1)!
		expect(dock.frames[0]).toMatchObject({
			left: '550px',
			top: '270px',
			width: '432px',
			height: '514px',
		})
		expect(dock.frames[1]).toMatchObject({
			left: '0px',
			top: '48px',
			width: '620px',
			height: '752px',
		})
		expect(f.effects.heading.at(-1)!.frames).toEqual([
			{ height: '30px', opacity: 0.7 },
			{ height: '0px', opacity: 0 },
		])
		opening.finish()
		expect(f.stage.style.position).toBe('absolute')
		dock.finish()
		expect(f.heading.style.display).toBeUndefined()
		expect(f.heading.style.height).toBeUndefined()
		expect(f.stage.style.gridColumn).toBeUndefined()
	})

	it('uses no effects with reduced motion and settles an active exit when the preference changes', () => {
		const reduced = fixture(true)
		open(reduced)
		expect(reduced.effects.frame).toHaveLength(0)
		reduced.motion.capture()
		reduced.motion.update({ layout: 'floating', rendered: true, visible: false })
		expect(reduced.onHidden).toHaveBeenCalledOnce()
		expect(reduced.stage.style.opacity).toBe('0')
		const f = fixture()
		open(f).finish()
		f.motion.capture()
		f.motion.update({ layout: 'floating', rendered: true, visible: false })
		const closing = f.effects.frame.at(-1)!
		f.reduce()
		expect(closing.cancel).toHaveBeenCalledOnce()
		expect(f.onHidden).toHaveBeenCalledOnce()
		closing.finish()
		expect(f.onHidden).toHaveBeenCalledOnce()
	})

	it('preserves an in-flight effect on an unrelated render and removes every effect on disposal', () => {
		const f = fixture()
		const opening = open(f)
		f.motion.update({ layout: 'floating', rendered: true, visible: true })
		expect(f.effects.frame).toHaveLength(1)
		expect(opening.cancel).not.toHaveBeenCalled()
		f.motion.dispose()
		for (const kind of Object.values(f.effects))
			for (const effect of kind) expect(effect.cancel).toHaveBeenCalledOnce()
		expect(f.stage.style.position).toBeUndefined()
		expect(f.heading.style.display).toBeUndefined()
		expect(f.media.removeEventListener).toHaveBeenCalledOnce()
		opening.finish()
		expect(f.onHidden).not.toHaveBeenCalled()
	})
})
