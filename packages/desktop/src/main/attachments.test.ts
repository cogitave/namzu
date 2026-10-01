import { expect, it } from 'vitest'
import { admitAttachment, validateAttachmentBatch } from './attachments.js'

const png = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBz8AAAAASUVORK5CYII=',
	'base64',
)
it('sniffs actual image bytes and makes a safe preview rather than trusting an extension', () => {
	const admitted = admitAttachment({ name: 'wrong.txt', bytes: png })
	expect(admitted.view).toMatchObject({
		name: 'wrong.txt',
		kind: 'image',
		mediaType: 'image/png',
		size: png.byteLength,
	})
	expect(admitted.image?.data).toBe(png.toString('base64'))
	expect(admitted.view.preview).toBe(`data:image/png;base64,${png.toString('base64')}`)
})
it('snapshots text bytes, rejects unsupported binary/documents and sanitizes display names', () => {
	const bytes = Buffer.from('owned text')
	const admitted = admitAttachment({ name: 'notes\n.txt', bytes })
	bytes.fill(0)
	expect(admitted.text).toBe('owned text')
	expect(admitted.view.name).toBe('notes .txt')
	for (const bytes of [Buffer.from([255, 255]), Buffer.from('%PDF-1.7'), Buffer.from([0, 1, 2])]) {
		expect(() => admitAttachment({ name: 'file', bytes })).toThrow(
			'not a supported image or UTF-8 text',
		)
	}
})
it('bounds count, individual text bytes and aggregate image/text budgets', () => {
	expect(() =>
		validateAttachmentBatch(
			Array.from({ length: 9 }, () =>
				admitAttachment({ name: 'small.txt', bytes: Buffer.from('x') }),
			),
		),
	).toThrow('eight')
	expect(() =>
		admitAttachment({ name: 'large.txt', bytes: Buffer.alloc(128 * 1024 + 1, 65) }),
	).toThrow('128 KiB')
	const image = Buffer.alloc(2 * 1024 * 1024)
	png.copy(image)
	expect(() =>
		validateAttachmentBatch([
			admitAttachment({ name: 'a.png', bytes: image }),
			admitAttachment({ name: 'b.png', bytes: image }),
		]),
	).toThrow('3 MiB')
	expect(() =>
		validateAttachmentBatch(
			Array.from({ length: 3 }, () =>
				admitAttachment({ name: 'text.txt', bytes: Buffer.alloc(128 * 1024, 65) }),
			),
		),
	).toThrow('256 KiB')
})
