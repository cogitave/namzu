const COPIED = [
	'fontFamily',
	'fontSize',
	'fontWeight',
	'fontStyle',
	'letterSpacing',
	'lineHeight',
	'textTransform',
	'textIndent',
	'wordSpacing',
	'tabSize',
	'paddingTop',
	'paddingRight',
	'paddingBottom',
	'paddingLeft',
	'boxSizing',
] as const

/** Gives a layer behind the box the box's own type and padding, so the same letters land in the same places. */
export function copyBoxText(from: HTMLElement, to: HTMLElement): void {
	const style = getComputedStyle(from)
	for (const name of COPIED) to.style[name] = style[name]
	to.style.whiteSpace = 'pre-wrap'
	to.style.overflowWrap = 'break-word'
}

/**
 * Where a character of the box sits on screen: its left edge and the top of its line. A hidden copy
 * of the text up to the character is laid out with the box's own type and width, and a marker at its
 * end is read. Nothing is drawn.
 */
export function caretPoint(
	box: HTMLTextAreaElement,
	index: number,
): { x: number; lineTop: number; lineHeight: number } {
	const probe = document.createElement('div')
	copyBoxText(box, probe)
	probe.style.position = 'fixed'
	probe.style.visibility = 'hidden'
	probe.style.pointerEvents = 'none'
	probe.style.top = '0'
	probe.style.left = '0'
	probe.style.width = `${box.clientWidth}px`
	probe.style.borderWidth = '0'
	probe.textContent = box.value.slice(0, index)
	const marker = document.createElement('span')
	marker.textContent = '​'
	probe.appendChild(marker)
	document.body.appendChild(probe)
	const rect = box.getBoundingClientRect()
	const x = rect.left + box.clientLeft + marker.offsetLeft - box.scrollLeft
	const lineTop = rect.top + box.clientTop + marker.offsetTop - box.scrollTop
	const lineHeight = marker.offsetHeight
	probe.remove()
	return { x, lineTop, lineHeight }
}
