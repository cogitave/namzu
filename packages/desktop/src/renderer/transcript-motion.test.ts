import { describe, expect, it, vi } from 'vitest'
import { emptyThread } from '../shared/projection.js'
import {
	createTranscriptEntryMotion,
	createTranscriptPhaseMotion,
	livePhaseLabel,
	turnActivityLabel,
} from './transcript-motion.js'

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
		for (const listener of this.listeners) listener()
	}
}

function fixture() {
	const effects: { node: Element; effect: Effect }[] = []
	const listeners = new Set<() => void>()
	const media = {
		matches: false,
		addEventListener: (_: string, fn: () => void) => listeners.add(fn),
		removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
	}
	let history = 'authoritative'
	let paintedHeight: number | undefined
	const style = (): Record<string, string | ((property: string) => void)> => {
		const value: Record<string, string | ((property: string) => void)> = {}
		value.removeProperty = (property) => {
			delete value[property.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())]
		}
		return value
	}
	class Node {
		style = style()
		dataset: Record<string, string> = {}
		attributes: Record<string, string> = {}
		textContent = ''
		paintOpacity = '1'
		parentElement: Node | null = null
		children: Node[] = []
		scrollHeight = 52
		ownerDocument = {
			defaultView: {
				matchMedia: () => media,
				getComputedStyle: (node: Node) => ({
					opacity: node.paintOpacity,
					paddingTop: '12px',
					paddingBottom: '20px',
					getPropertyValue: () => '',
				}),
			},
		}
		animate = vi.fn((frames: Keyframe[], options: KeyframeAnimationOptions) => {
			const effect = new Effect(frames, options)
			effects.push({ node: this as unknown as Element, effect })
			return effect
		})
		setAttribute(name: string, value: string) {
			this.attributes[name] = value
		}
		closest() {
			return { dataset: { historyState: history } }
		}
		querySelector() {
			return text
		}
		querySelectorAll() {
			return this.children
		}
		getBoundingClientRect() {
			return {
				height:
					this.style.display === 'none'
						? 0
						: (paintedHeight ?? Number.parseFloat(String(this.style.height ?? '52'))),
			}
		}
		cloneNode() {
			const clone = new Node()
			clone.textContent = this.textContent
			return clone
		}
		append(node: Node) {
			node.parentElement = this
			this.children.push(node)
		}
		remove() {
			if (this.parentElement)
				this.parentElement.children = this.parentElement.children.filter((child) => child !== this)
		}
	}
	const root = new Node()
	const text = new Node()
	root.append(text)
	return {
		root: root as unknown as HTMLElement,
		text,
		effects,
		media,
		row(key: string) {
			const row = new Node()
			row.dataset.transcriptEntryKey = key
			root.append(row)
			return row
		},
		history(value: string) {
			history = value
		},
		paint(height: number, opacity = '1') {
			paintedHeight = height
			root.paintOpacity = opacity
		},
		clearPaint() {
			paintedHeight = undefined
			root.paintOpacity = '1'
		},
		reduce() {
			media.matches = true
			for (const listener of listeners) listener()
		},
	}
}

function historyThread() {
	const thread = emptyThread()
	thread.turn = 1
	thread.messages = [
		{ role: 'user', text: 'Saved prompt' },
		{ role: 'assistant', text: 'Saved answer' },
	]
	thread.timeline = [
		{ kind: 'message', index: 0, turn: 1 },
		{ kind: 'message', index: 1, turn: 1 },
	]
	return thread
}

describe('normal transcript entry provenance', () => {
	it('baselines mounted and restored running history, then animates a new live entry only once', () => {
		const f = fixture()
		const controller = createTranscriptEntryMotion(f.root)
		const thread = historyThread()
		f.row('message-0')
		f.row('message-1')
		controller.update(emptyThread(), false)
		thread.running = true
		controller.update(thread, false)
		controller.update(thread, true)
		expect(f.effects).toEqual([])
		const added = f.row('message-2')
		thread.messages.push({ role: 'assistant', text: 'New chunk' })
		thread.timeline.push({ kind: 'message', index: 2, turn: 1 })
		controller.update(thread, true)
		expect(added.animate).toHaveBeenCalledOnce()
		expect(f.effects[0]?.effect.options.duration).toBe(120)
		expect(f.effects[0]?.effect.frames).toEqual([{ opacity: 0.65 }, { opacity: 1 }])
		thread.messages[2].text += ' continued'
		controller.update(thread, true)
		expect(added.animate).toHaveBeenCalledOnce()
		controller.dispose()
		expect(f.effects[0]?.effect.cancel).toHaveBeenCalledOnce()
	})

	it('does not animate idle history replacements or a loading-to-authoritative hydration', () => {
		const f = fixture()
		const controller = createTranscriptEntryMotion(f.root)
		controller.update(emptyThread())
		f.row('message-0')
		f.row('message-1')
		const thread = historyThread()
		controller.update(thread)
		expect(f.effects).toEqual([])
		f.history('loading')
		controller.update(emptyThread())
		f.history('authoritative')
		thread.running = true
		controller.update(thread)
		expect(f.effects).toEqual([])
	})

	it('cancels admitted effects immediately when reduced motion or restoration begins', () => {
		const f = fixture()
		const controller = createTranscriptEntryMotion(f.root)
		const thread = historyThread()
		thread.running = true
		controller.update(thread)
		f.row('message-2')
		thread.messages.push({ role: 'assistant', text: 'Fresh' })
		thread.timeline.push({ kind: 'message', index: 2, turn: 1 })
		controller.update(thread)
		f.reduce()
		expect(f.effects[0]?.effect.cancel).toHaveBeenCalledOnce()
		controller.update(thread, false)
		expect(f.effects).toHaveLength(1)
	})
})

describe('phase transition interruption', () => {
	it('keeps one readable label and resumes interrupted changes without darkening the text', () => {
		const f = fixture()
		const controller = createTranscriptPhaseMotion(f.root)
		f.text.textContent = 'Working'
		controller.update('Working')
		expect(f.effects).toEqual([])
		f.text.textContent = 'Thinking'
		controller.update('Thinking')
		expect(f.effects.map(({ effect }) => effect.id)).toEqual(['namzu-transcript-phase-in'])
		expect(f.effects[0]?.effect.options.duration).toBe(120)
		expect(f.effects[0]?.effect.frames[0]).toEqual({ opacity: 0.65 })
		expect((f.root as unknown as { children: unknown[] }).children).toHaveLength(1)
		f.text.paintOpacity = '0.8'
		f.text.textContent = 'Working'
		controller.update('Working')
		expect(f.effects[1]?.effect.frames[0]).toEqual({ opacity: 0.8 })
		const count = f.effects.length
		controller.update('Working')
		expect(f.effects).toHaveLength(count)
		f.reduce()
		expect((f.root as unknown as { children: unknown[] }).children).toHaveLength(1)
	})

	it('preserves an interrupted exit frame and ignores queued finish from the cancelled exit', () => {
		const f = fixture()
		const controller = createTranscriptPhaseMotion(f.root, true)
		f.text.textContent = 'Working'
		controller.update('Working')
		controller.update(undefined)
		const exit = f.effects[0]?.effect
		expect(f.effects[0]?.effect.options.duration).toBe(160)
		f.paint(26, '0.5')
		f.text.textContent = 'Thinking'
		controller.update('Thinking')
		expect(f.effects[2]?.effect.frames[0]).toMatchObject({
			height: '26px',
			opacity: 0.5,
		})
		exit?.finish()
		expect(f.root.style.display).not.toBe('none')
		f.clearPaint()
		f.effects[2]?.effect.finish()
		expect(f.root.style.height).toBeUndefined()
		controller.update(undefined)
		f.reduce()
		expect(f.root.style.display).toBe('none')
	})
})

describe('truthful turn labels', () => {
	it('uses real phase priority, keeps completed duration and separates stop/pause duration', () => {
		const thread = emptyThread()
		thread.turn = 1
		thread.running = true
		expect(livePhaseLabel(thread)).toBe('Working')
		thread.activeReasoningId = 'r'
		thread.reasoning.r = { text: '', status: 'pending', turn: 1 }
		expect(turnActivityLabel(thread, 1)).toBe('Thinking')
		thread.permissions = [{ id: 'review', sessionId: 's', projectId: 'p', calls: [] }]
		expect(turnActivityLabel(thread, 1)).toBe('Waiting for your decision')
		thread.running = false
		thread.turns[1] = {
			startedAt: 1000,
			endedAt: 66000,
			stopReason: 'end_turn',
		}
		expect(turnActivityLabel(thread, 1)).toBe('Worked for 1m 5s')
		thread.turns[1].stopReason = 'cancelled'
		expect(turnActivityLabel(thread, 1)).toBe('Stopped · 1m 5s')
		thread.turns[1].reason = 'paused'
		expect(turnActivityLabel(thread, 1)).toBe('Paused · 1m 5s')
		thread.turns[1].reason = 'structured_output_failed'
		expect(turnActivityLabel(thread, 1)).toBe('Work incomplete · 1m 5s')
		thread.turns[1].reason = undefined
		thread.turns[1].stopReason = 'end_turn'
		thread.error = 'Reported provider error'
		expect(turnActivityLabel(thread, 1)).toBe('Work incomplete · 1m 5s')
		expect(livePhaseLabel(thread)).toBeUndefined()
	})
})
