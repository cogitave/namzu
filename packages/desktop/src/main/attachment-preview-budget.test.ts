import { expect, it } from 'vitest'
import type { AttachmentView } from '../shared/protocol.js'
import {
	AttachmentPreviewBudget,
	MAX_MESSAGE_PREVIEW_REFERENCES,
} from './attachment-preview-budget.js'

const image = (id: string, preview = '1234'): AttachmentView => ({
	id,
	name: `${id}.png`,
	kind: 'image',
	size: 3,
	mediaType: 'image/png',
	preview,
})

it('keeps a global byte budget and promotes retained owner reads without restoring data', () => {
	const budget = new AttachmentPreviewBudget(8)
	expect(budget.admit('a', [image('1')])).toEqual([])
	expect(budget.admit('b', [image('2')])).toEqual([])
	budget.touch('a')
	expect(budget.admit('c', [image('3')])).toEqual([{ sessionId: 'b', attachmentIds: ['2'] }])
	budget.touch('b')
	expect(budget.admit('d', [image('4')])).toEqual([{ sessionId: 'a', attachmentIds: ['1'] }])
})

it('charges repeated message copies and retires all references of that owned ID together', () => {
	const budget = new AttachmentPreviewBudget(12)
	expect(budget.admit('a', [image('same'), image('other')])).toEqual([])
	expect(budget.admit('b', [image('same')])).toEqual([])
	expect(budget.admit('a', [image('same')])).toEqual([{ sessionId: 'a', attachmentIds: ['same'] }])
	// The foreign same-ID reference and the unrelated owned reference remain.
	expect(budget.admit('c', [image('new')])).toEqual([])
	expect(budget.admit('d', [image('last')])).toEqual([{ sessionId: 'a', attachmentIds: ['other'] }])
})

it('bounds tiny image references separately and never keeps admitted objects', () => {
	const budget = new AttachmentPreviewBudget()
	const files = Array.from({ length: MAX_MESSAGE_PREVIEW_REFERENCES }, (_, index) =>
		image(String(index), 'x'),
	)
	expect(budget.admit('a', files)).toEqual([])
	files[0]!.id = 'mutated'
	files[0]!.preview = 'changed'
	expect(budget.admit('b', [image('next', 'x')])).toEqual([
		{ sessionId: 'a', attachmentIds: ['0'] },
	])
})

it('counts encoded UTF-8 preview bytes, ignores absent and text previews, and releases retired owners', () => {
	const budget = new AttachmentPreviewBudget(4)
	expect(budget.admit('a', [image('1', 'éé')])).toEqual([])
	expect(
		budget.admit('b', [
			{ ...image('text'), kind: 'text' },
			{ ...image('missing'), preview: undefined },
		]),
	).toEqual([])
	expect(budget.admit('b', [image('2', 'x')])).toEqual([{ sessionId: 'a', attachmentIds: ['1'] }])
	budget.forget('b')
	expect(budget.admit('c', [image('3')])).toEqual([])
	budget.clear()
	expect(budget.admit('d', [image('4')])).toEqual([])
})

it('retires over-budget single values without permitting a higher configured limit', () => {
	expect(new AttachmentPreviewBudget(0).admit('a', [image('1')])).toEqual([
		{ sessionId: 'a', attachmentIds: ['1'] },
	])
	expect(() => new AttachmentPreviewBudget(Number.POSITIVE_INFINITY)).toThrow(
		'Invalid message preview budget',
	)
	expect(() => new AttachmentPreviewBudget(17 * 1024 * 1024)).toThrow(
		'Invalid message preview budget',
	)
})
