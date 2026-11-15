/**
 * Reaching the right element: where a click or hover lands, how a role/name
 * or text target is described, which keys may go to the page without a ref,
 * and how a failed action is told apart by cause.
 *
 * The functions marked "serialised" run inside the page and must stay
 * self-contained (see page-scripts.ts for the rules that apply to them).
 */
import type { BrowserTargetCandidate } from '@namzu/sdk'

/** Keys `press` accepts without a ref. None of them enters a character except Enter and Space. */
export const NAMED_KEYS = [
	'Escape',
	'Enter',
	'Tab',
	'Shift+Tab',
	'PageDown',
	'PageUp',
	'Home',
	'End',
	'Space',
] as const

export type NamedKey = (typeof NAMED_KEYS)[number]

/** The canonical spelling of an accepted key, or undefined for any other. */
export function namedKey(raw: string): NamedKey | undefined {
	const wanted = raw.trim().toLowerCase()
	return NAMED_KEYS.find((key) => key.toLowerCase() === wanted)
}

/** Keys that put a character in a field or submit a form, so the focus must be known to be safe. */
export function keyCanCommit(key: NamedKey): boolean {
	return key === 'Enter' || key === 'Space'
}

/** How long between key presses when `type` sends real key events. */
export const KEY_DELAY_MS = 20

/** Most candidates a refusal lists. */
export const CANDIDATES_MAX = 8

/** Where inside the element to aim, or the sign to use the middle. */
export type Aim =
	| { readonly kind: 'centre' }
	| { readonly kind: 'descendant'; readonly path: string }
	| { readonly kind: 'text'; readonly x: number; readonly y: number }

/**
 * Where to land on an element that is a container rather than a control:
 * its first visible control, else the box of its own first text, else the
 * middle. An element that is itself a control, or looks clickable, keeps the
 * middle. `path` is an XPath relative to the element.
 *
 * Serialised; keep it self-contained.
 */
export function aimInside(el: Element): Aim {
	const controls =
		'a[href],button,input:not([type=hidden]),select,textarea,summary,label,[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=treeitem],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex^="-"])'
	const shown = (node: Element): boolean => {
		const rect = node.getBoundingClientRect()
		if (rect.width < 1 || rect.height < 1) return false
		const style = getComputedStyle(node)
		return style.visibility !== 'hidden' && style.display !== 'none'
	}
	if (
		el.matches(controls) ||
		el.hasAttribute('onclick') ||
		getComputedStyle(el).cursor === 'pointer'
	) {
		return { kind: 'centre' }
	}
	const inner = Array.from(el.querySelectorAll(controls)).find(shown)
	if (inner) {
		const steps: number[] = []
		let node: Element | null = inner
		while (node && node !== el) {
			const parent: Element | null = node.parentElement
			if (!parent) return { kind: 'centre' }
			steps.unshift(Array.prototype.indexOf.call(parent.children, node) + 1)
			node = parent
		}
		return { kind: 'descendant', path: `./${steps.map((i) => `*[${i}]`).join('/')}` }
	}
	const box = el.getBoundingClientRect()
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const parent = node.parentElement
		if (!parent || !(node.textContent ?? '').trim() || !shown(parent)) continue
		if (/^(script|style|noscript|template)$/i.test(parent.tagName)) continue
		const range = document.createRange()
		range.selectNodeContents(node)
		const rect = Array.from(range.getClientRects()).find((r) => r.width >= 1 && r.height >= 1)
		if (!rect) continue
		if (box.width <= rect.width * 1.5 + 8 && box.height <= rect.height * 1.5 + 8) {
			return { kind: 'centre' }
		}
		return {
			kind: 'text',
			x: rect.left + rect.width / 2 - (box.left + el.clientLeft),
			y: rect.top + rect.height / 2 - (box.top + el.clientTop),
		}
	}
	return { kind: 'centre' }
}

/**
 * The deepest focused element, through open shadow roots and same-origin
 * frames, or null when nothing but the page is focused.
 *
 * Serialised; keep it self-contained.
 */
export function deepFocus(): Element | null {
	let active: Element | null = document.activeElement
	for (let depth = 0; active && depth < 20; depth++) {
		if (active.shadowRoot?.activeElement) {
			active = active.shadowRoot.activeElement
			continue
		}
		const frame = active as HTMLIFrameElement
		const inner = frame.tagName === 'IFRAME' ? frame.contentDocument?.activeElement : null
		if (inner) {
			active = inner
			continue
		}
		break
	}
	return !active || active === document.body || active === document.documentElement ? null : active
}

/**
 * Whether the focused element is one whose inside cannot be read: a shadow
 * host. A plain element only holds the focus when it is a control, a frame,
 * editable, or given a tab stop; any other element holding it is a host whose
 * root is closed (an open root is followed by {@link deepFocus}). Serialised.
 */
export function focusIsOpaque(el: Element): boolean {
	return !el.matches(
		'input,textarea,select,button,a[href],area[href],summary,iframe,object,embed,[contenteditable]:not([contenteditable=false]),[tabindex]',
	)
}

/** What a candidate looks like to a person: its role and its name. Serialised. */
export function describeCandidate(el: Element): BrowserTargetCandidate {
	const tag = el.tagName.toLowerCase()
	const input = el as HTMLInputElement
	const implicit: Record<string, string> = {
		a: 'link',
		button: 'button',
		select: 'combobox',
		textarea: 'textbox',
		summary: 'button',
		li: 'listitem',
		img: 'image',
		nav: 'navigation',
		table: 'table',
		h1: 'heading',
		h2: 'heading',
		h3: 'heading',
		h4: 'heading',
		h5: 'heading',
		h6: 'heading',
	}
	let role = el.getAttribute('role') ?? implicit[tag] ?? tag
	if (tag === 'input') {
		const type = (input.type || 'text').toLowerCase()
		role = ['checkbox', 'radio'].includes(type)
			? type
			: ['button', 'submit', 'reset', 'image'].includes(type)
				? 'button'
				: 'textbox'
	}
	const raw =
		el.getAttribute('aria-label') ||
		(el as HTMLElement).innerText ||
		el.textContent ||
		input.value ||
		el.getAttribute('title') ||
		el.getAttribute('placeholder') ||
		''
	return { role, name: raw.replace(/\s+/g, ' ').trim().slice(0, 80) }
}

/** Why an action that stopped before touching the page stopped, in a clause. */
export function noEffectReason(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error)
	if (/intercepts pointer events/i.test(text)) return 'another element is covering it'
	if (/not visible/i.test(text)) return 'it is not visible'
	if (/not enabled/i.test(text)) return 'it is disabled'
	if (/not stable/i.test(text)) return 'it kept moving'
	if (/not attached|detached/i.test(text)) return 'it left the page'
	if (/outside of the viewport/i.test(text))
		return 'it is outside the visible area and could not be scrolled in'
	if (/timeout/i.test(text)) return 'it did not become ready to act on in time'
	return (text.split('\n')[0] ?? '').slice(0, 160)
}

/**
 * Did a failed action stop before it did anything? Playwright logs
 * "performing <action> action" the moment it sends input, so a timeout whose
 * log never reaches that line left the page alone. Anything else — including
 * an error that carries no log — may have changed the page.
 */
export function failedBeforeActing(error: unknown): boolean {
	if (!(error instanceof Error)) return false
	const text = error.message
	if (error.name !== 'TimeoutError' && !/Timeout \d+ms exceeded/.test(text)) return false
	return !/performing \w+ action|action done|scheduled navigations/i.test(text)
}
