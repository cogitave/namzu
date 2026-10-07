import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { AttachmentView } from '../shared/protocol.js'
import { AttachmentList, neighbourAfterRemoval } from './attachment-list.js'

const image: AttachmentView = {
	id: 'image',
	name: 'Reference.png',
	kind: 'image',
	size: 2048,
	mediaType: 'image/png',
}
const preview = 'data:image/png;base64,iVBORw0KGgo='
function markup(
	attachments: AttachmentView[],
	options: { onRemove?: (id: string) => void; disabled?: boolean } = {},
) {
	return renderToStaticMarkup(createElement(AttachmentList, { attachments, ...options }))
}

it('shows truthful image metadata when preview bytes are unavailable without offering a fake preview action', () => {
	const html = markup([image])
	expect(html).toContain('aria-label="Message attachments"')
	expect(html).toContain('Reference.png')
	expect(html).toContain('Image · 2 KB · Preview unavailable')
	expect(html).not.toContain('<img')
	expect(html).not.toContain('aria-label="Preview ')
	expect(html).not.toContain('<button')
	expect(html).toMatch(/<li[^>]*tabindex="-1"[^>]*aria-label="Reference.png: Preview unavailable"/)
})

it('keeps available draft and queued image thumbnails and removal controls', () => {
	const html = markup([{ ...image, preview }], { onRemove: vi.fn() })
	expect(html).toContain('aria-label="Attached files"')
	expect(html).toContain('aria-label="Preview Reference.png"')
	expect(html).toContain(`src="${preview}"`)
	expect(html).toContain('alt="Reference.png"')
	expect(html).toContain('aria-label="Remove Reference.png"')
	expect(html).not.toContain('Preview unavailable')
	expect(html).not.toContain('tabindex="-1"')
})

it('retains disabled removal semantics even if an image preview is absent', () => {
	const html = markup([image], { onRemove: vi.fn(), disabled: true })
	expect(html).toContain('aria-label="Remove Reference.png"')
	expect(html).toMatch(/<button[^>]*disabled=""/)
	expect(html).toContain('Preview unavailable')
	expect(html).not.toContain('aria-label="Preview ')
})

it('keeps text file metadata unchanged and renders an empty attachment list as nothing', () => {
	const html = markup([
		{ ...image, id: 'text', kind: 'text', name: 'Notes.txt', mediaType: 'text/plain' },
	])
	expect(html).toContain('Text file · 2 KB')
	expect(html).not.toContain('Preview unavailable')
	expect(html).not.toContain('<img')
	expect(html).not.toContain('tabindex="-1"')
	expect(markup([])).toBe('')
})

it('picks the next chip, else the previous, else nothing to hand focus to', () => {
	const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
	expect(neighbourAfterRemoval(items, 'a')).toBe('b')
	expect(neighbourAfterRemoval(items, 'b')).toBe('c')
	expect(neighbourAfterRemoval(items, 'c')).toBe('b')
	expect(neighbourAfterRemoval([{ id: 'a' }], 'a')).toBeUndefined()
	expect(neighbourAfterRemoval(items, 'missing')).toBeUndefined()
})
