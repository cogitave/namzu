import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { PREVIEW_MAX_BYTES, buildFilePreview, withPreviews } from '../permission-preview.js'

let dir: string

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'namzu-preview-'))
})
afterEach(async () => {
	await removeTempDir(dir)
})

const file = (name: string, body: string | Buffer) => writeFile(join(dir, name), body)
const preview = (name: string, input: unknown) => buildFilePreview({ name, input }, [dir])

describe('the preview of a pending file change', () => {
	it('runs a single replacement against the file as it is', async () => {
		await file('a.ts', 'one\ntwo\nthree\n')
		const result = await preview('edit', { path: 'a.ts', old_string: 'two', new_string: 'TWO' })
		expect(result).toMatchObject({ before: 'one\ntwo\nthree\n', after: 'one\nTWO\nthree\n' })
		expect(result?.path.endsWith('a.ts')).toBe(true)
	})

	it('honours replace_all, a batch and an insert', async () => {
		await file('a.ts', 'x\nx\ny\n')
		expect(
			(await preview('edit', { path: 'a.ts', old_string: 'x', new_string: 'z', replace_all: true }))
				?.after,
		).toBe('z\nz\ny\n')
		expect(
			(
				await preview('edit', {
					path: 'a.ts',
					edits: [
						{ old_string: 'y', new_string: 'why' },
						{ old_string: 'why', new_string: 'because' },
					],
				})
			)?.after,
		).toBe('x\nx\nbecause\n')
		expect(
			(await preview('edit', { path: 'a.ts', insertLine: 'end', new_string: 'tail' }))?.after,
		).toBe('x\nx\ny\ntail\n')
	})

	it('shows an ambiguous or failing edit as no preview, because the tool would refuse it', async () => {
		await file('a.ts', 'x\nx\n')
		expect(
			await preview('edit', { path: 'a.ts', old_string: 'x', new_string: 'z' }),
		).toBeUndefined()
		expect(
			await preview('edit', { path: 'a.ts', old_string: 'q', new_string: 'z' }),
		).toBeUndefined()
	})

	it('treats write to a new file as before: null and to an existing file as a replacement', async () => {
		expect(await preview('write', { path: 'new.md', content: 'hello\n' })).toMatchObject({
			before: null,
			after: 'hello\n',
		})
		await file('old.md', 'old\n')
		expect(await preview('write', { path: 'old.md', content: 'new\n' })).toMatchObject({
			before: 'old\n',
			after: 'new\n',
		})
		expect(await preview('write', { path: 'old.md', newStr: 'alias\n' })).toMatchObject({
			after: 'alias\n',
		})
	})

	it('has no preview for an edit of a file that is not there', async () => {
		expect(
			await preview('edit', { path: 'gone.ts', old_string: 'a', new_string: 'b' }),
		).toBeUndefined()
	})

	it('has no preview for a binary file or one over the size cap', async () => {
		await file('bin.dat', Buffer.from([1, 2, 0, 3]))
		expect(await preview('write', { path: 'bin.dat', content: 'text' })).toBeUndefined()
		await file('big.txt', 'a'.repeat(PREVIEW_MAX_BYTES + 1))
		expect(await preview('write', { path: 'big.txt', content: 'small' })).toBeUndefined()
		expect(
			await preview('write', { path: 'huge.txt', content: 'a'.repeat(PREVIEW_MAX_BYTES + 1) }),
		).toBeUndefined()
	})

	it('has no preview for a path outside the roots, another tool, or a change that changes nothing', async () => {
		expect(await preview('write', { path: '../escape.txt', content: 'x' })).toBeUndefined()
		expect(
			await buildFilePreview({ name: 'bash', input: { command: 'ls' } }, [dir]),
		).toBeUndefined()
		await file('same.txt', 'same')
		expect(await preview('write', { path: 'same.txt', content: 'same' })).toBeUndefined()
	})

	it('does not read through a link that leaves the roots, nor a CRLF body differently from the tool', async () => {
		const outside = await mkdtemp(join(tmpdir(), 'namzu-preview-outside-'))
		try {
			await writeFile(join(outside, 'secret.txt'), 'secret\n')
			await symlink(join(outside, 'secret.txt'), join(dir, 'link.txt'))
			await symlink(outside, join(dir, 'linkdir'))
			expect(
				await preview('edit', { path: 'link.txt', old_string: 'secret', new_string: 'x' }),
			).toBeUndefined()
			expect(
				await preview('edit', {
					path: 'linkdir/secret.txt',
					old_string: 'secret',
					new_string: 'x',
				}),
			).toBeUndefined()
			expect(await preview('write', { path: 'linkdir/new.txt', content: 'x' })).toBeUndefined()
		} finally {
			await removeTempDir(outside)
		}
		await file('crlf.txt', 'a\r\nb\r\n')
		expect(
			(await preview('edit', { path: 'crlf.txt', old_string: 'a\nb', new_string: 'x\ny' }))?.after,
		).toBe('x\r\ny\r\n')
	})

	it('finds a file under a sub-directory that is not there yet', async () => {
		await mkdir(join(dir, 'src'))
		expect(await preview('write', { path: 'src/deep/new.ts', content: 'x' })).toMatchObject({
			before: null,
		})
	})

	it('keeps the four review fields and adds the preview only where there is one', async () => {
		await file('a.ts', 'a\n')
		const calls = await withPreviews(
			[
				{
					id: '1',
					name: 'edit',
					input: { path: 'a.ts', old_string: 'a', new_string: 'b' },
					isDestructive: false,
				},
				{ id: '2', name: 'bash', input: { command: 'ls' }, isDestructive: true },
			],
			[dir],
		)
		expect(calls[0]).toMatchObject({
			id: '1',
			name: 'edit',
			isDestructive: false,
			preview: { after: 'b\n' },
		})
		expect(calls[1]).toEqual({
			id: '2',
			name: 'bash',
			input: { command: 'ls' },
			isDestructive: true,
		})
	})
})
