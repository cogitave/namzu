/**
 * Functions the host runs inside the page. Each is serialised by Playwright
 * and must not close over anything in this module.
 *
 * They run in the page's main world, so a hostile page can lie to them. They
 * are hygiene — counting password boxes, dropping text nobody can see — not a
 * boundary: the boundary is the gate, the origin check, the refusal to type
 * into a credential field (checked again right before typing), and the
 * untrusted envelope around everything the page says.
 */

/** Visible password and one-time-code fields on the page. */
export interface FieldCounts {
	readonly passwordFields: number
	readonly oneTimeCodeFields: number
}

// The body of this function is serialised; keep it self-contained.
export function countCredentialFields(): FieldCounts {
	const oneTime =
		/(?:^|[^a-z])(?:otp|totp|2fa|mfa|one[-_ ]?time[-_ ]?(?:code|password)|verification[-_ ]?code|passcode|security[-_ ]?code|auth(?:entication)?[-_ ]?code)(?:[^a-z]|$)/i
	const visible = (el: Element): boolean => {
		const rect = el.getBoundingClientRect()
		if (rect.width < 2 || rect.height < 2) return false
		const style = getComputedStyle(el)
		return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0
	}
	let passwordFields = 0
	let oneTimeCodeFields = 0
	for (const input of Array.from(document.querySelectorAll('input'))) {
		if (!visible(input)) continue
		const autocomplete = (input.getAttribute('autocomplete') ?? '').toLowerCase()
		if (input.type === 'password' || /\bcurrent-password\b/.test(autocomplete)) {
			passwordFields += 1
			continue
		}
		const label = [input.name, input.id, input.getAttribute('aria-label') ?? ''].join(' ')
		if (/\bone-time-code\b/.test(autocomplete) || oneTime.test(label)) oneTimeCodeFields += 1
	}
	return { passwordFields, oneTimeCodeFields }
}

/** What {@link fieldFacts} returns: the facts `isCredentialField` reads. */
export interface ElementFieldFacts {
	readonly tag: string
	readonly type: string
	readonly autocomplete: string
	readonly name: string
	readonly id: string
	readonly label: string
	/** `checkbox`, `radio`, `select`, `file`, or `text`. */
	readonly kind: 'checkbox' | 'radio' | 'select' | 'file' | 'text'
}

// Serialised; keep it self-contained.
export function fieldFacts(el: Element): ElementFieldFacts {
	const tag = el.tagName.toLowerCase()
	const input = el as HTMLInputElement
	const type = tag === 'input' ? (input.type || 'text').toLowerCase() : ''
	const labels =
		'labels' in input && input.labels
			? Array.from(input.labels)
					.map((l) => l.textContent ?? '')
					.join(' ')
			: ''
	const label = [el.getAttribute('aria-label') ?? '', el.getAttribute('placeholder') ?? '', labels]
		.join(' ')
		.trim()
	const role = el.getAttribute('role') ?? ''
	const kind: ElementFieldFacts['kind'] =
		type === 'checkbox' || role === 'checkbox' || role === 'switch'
			? 'checkbox'
			: type === 'radio' || role === 'radio'
				? 'radio'
				: tag === 'select'
					? 'select'
					: type === 'file'
						? 'file'
						: 'text'
	return {
		tag,
		type,
		autocomplete: el.getAttribute('autocomplete') ?? '',
		name: el.getAttribute('name') ?? '',
		id: el.id ?? '',
		label,
		kind,
	}
}

// Serialised; keep it self-contained.
export function focusedFieldFacts(): ElementFieldFacts | null {
	let el: Element | null = document.activeElement
	while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement
	if (!el || el === document.body) return null
	const tag = el.tagName.toLowerCase()
	const input = el as HTMLInputElement
	const type = tag === 'input' ? (input.type || 'text').toLowerCase() : ''
	return {
		tag,
		type,
		autocomplete: el.getAttribute('autocomplete') ?? '',
		name: el.getAttribute('name') ?? '',
		id: el.id ?? '',
		label: [el.getAttribute('aria-label') ?? '', el.getAttribute('placeholder') ?? ''].join(' '),
		kind: 'text',
	}
}

/** A rectangle in viewport CSS pixels, as `getBoundingClientRect` reports it. */
export interface Rect {
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
}

/** {@link invisibleBoxes}' answer: the boxes and the page's scroll offset. */
export interface InvisibleBoxes {
	readonly scrollX: number
	readonly scrollY: number
	readonly boxes: readonly Rect[]
}

/**
 * Boxes of elements that are in the accessibility tree but that no one can
 * see: fully transparent (themselves or through an ancestor), text too small
 * to read, or text drawn in a transparent colour. Hidden-text prompt
 * injection lives here; `aria-hidden`, `display: none` and `visibility:
 * hidden` are already out of the tree.
 */
// Serialised; keep it self-contained.
export function invisibleBoxes(limit: number): InvisibleBoxes {
	const out: Rect[] = []
	const push = (el: Element): void => {
		const r = el.getBoundingClientRect()
		out.push({ x: r.x, y: r.y, width: r.width, height: r.height })
	}
	const walk = (el: Element, hiddenAbove: boolean): void => {
		if (out.length >= limit) return
		const style = getComputedStyle(el)
		const fontSize = Number.parseFloat(style.fontSize)
		const transparentText = /rgba\([^)]*,\s*0\)$/.test(style.color) || style.color === 'transparent'
		const hidden =
			hiddenAbove ||
			Number(style.opacity) === 0 ||
			(Number.isFinite(fontSize) && fontSize < 2) ||
			transparentText
		if (hidden) push(el)
		for (const child of Array.from(el.children)) walk(child, hidden && !transparentText)
	}
	if (document.body) walk(document.body, false)
	return { scrollX: window.scrollX, scrollY: window.scrollY, boxes: out }
}

/**
 * Start a clock of the last change to the page: a mutation observer that
 * stamps every change to the document. Run on every new document (an init
 * script) so a change made right after an action is not missed.
 */
// Serialised; keep it self-contained.
export function installMutationClock(): void {
	const w = window as unknown as { __namzuChangedAt?: number }
	if (w.__namzuChangedAt !== undefined) return
	w.__namzuChangedAt = performance.now()
	try {
		new MutationObserver(() => {
			w.__namzuChangedAt = performance.now()
		}).observe(document, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true,
		})
	} catch {
		// A document that cannot be observed counts as still.
	}
}

/** Milliseconds since the page last changed; a large number when the clock was never started. */
// Serialised; keep it self-contained.
export function msSinceLastChange(): number {
	const w = window as unknown as { __namzuChangedAt?: number }
	return w.__namzuChangedAt === undefined ? 1e9 : performance.now() - w.__namzuChangedAt
}

/** Whether the page has anything to read yet: text, or a control. */
// Serialised; keep it self-contained.
export function hasVisibleContent(): boolean {
	const body = document.body
	if (!body) return false
	if (body.innerText.trim().length > 0) return true
	return body.querySelector('input, button, select, textarea, img, a[href]') !== null
}

/** What {@link valueFacts} returns. */
export interface ValueFacts {
	readonly kind: 'select' | 'checkbox' | 'radio' | 'file' | 'text' | 'other'
	readonly value?: string
	readonly options?: readonly string[]
	readonly selected?: readonly string[]
	readonly state: readonly string[]
}

/** The current value and state of one element, read from the page itself. */
// Serialised; keep it self-contained.
export function valueFacts(el: Element): ValueFacts {
	const tag = el.tagName.toLowerCase()
	const input = el as HTMLInputElement
	const type = tag === 'input' ? (input.type || 'text').toLowerCase() : ''
	const state: string[] = []
	const aria = (name: string): string | null => el.getAttribute(name)
	if (aria('aria-expanded') === 'true') state.push('expanded')
	if (aria('aria-pressed') === 'true') state.push('pressed')
	if (aria('aria-invalid') === 'true') state.push('invalid')
	if ((el as HTMLInputElement).disabled || aria('aria-disabled') === 'true') state.push('disabled')
	if ((el as HTMLInputElement).readOnly || aria('aria-readonly') === 'true') state.push('readonly')
	if ((el as HTMLInputElement).required || aria('aria-required') === 'true') state.push('required')
	const clip = (text: string): string => {
		const t = text.replace(/\s+/g, ' ').trim()
		return t.length > 500 ? `${t.slice(0, 499)}…` : t
	}
	if (tag === 'select') {
		const select = el as HTMLSelectElement
		const labels = Array.from(select.options).map((o) => clip(o.label || o.text))
		const chosen = Array.from(select.selectedOptions).map((o) => clip(o.label || o.text))
		return {
			kind: 'select',
			...(chosen.length > 0 ? { value: chosen.join(', ') } : {}),
			options: labels.slice(0, 200),
			selected: chosen,
			state,
		}
	}
	if (type === 'checkbox' || type === 'radio') {
		if (input.checked) state.push('checked')
		else if (input.indeterminate) state.push('mixed')
		return { kind: type, state }
	}
	const role = aria('role') ?? ''
	if (role === 'checkbox' || role === 'radio' || role === 'switch') {
		const checked = aria('aria-checked')
		if (checked === 'true') state.push('checked')
		else if (checked === 'mixed') state.push('mixed')
		return { kind: role === 'radio' ? 'radio' : 'checkbox', state }
	}
	if (type === 'file') {
		const names = Array.from(input.files ?? []).map((f) => f.name)
		return { kind: 'file', ...(names.length > 0 ? { value: names.join(', ') } : {}), state }
	}
	if (tag === 'input' || tag === 'textarea') {
		return { kind: 'text', ...(input.value !== '' ? { value: clip(input.value) } : {}), state }
	}
	const now = aria('aria-valuenow')
	if (now !== null) return { kind: 'other', value: clip(aria('aria-valuetext') ?? now), state }
	if ((el as HTMLElement).isContentEditable) {
		const text = clip((el as HTMLElement).innerText ?? '')
		return { kind: 'text', ...(text ? { value: text } : {}), state }
	}
	const text = clip((el as HTMLElement).innerText ?? el.textContent ?? '')
	return { kind: 'other', ...(text ? { value: text } : {}), state }
}
