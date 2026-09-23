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
