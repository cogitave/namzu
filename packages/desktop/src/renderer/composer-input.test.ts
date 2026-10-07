import { expect, it } from 'vitest'
import { decidePaste } from './composer-input.js'

const base = { text: '', fileCount: 0, importDisabled: false, attachmentsSupported: true }

it('lets a plain text paste through untouched', () => {
	expect(decidePaste({ ...base, text: 'hello' })).toEqual({ action: 'default' })
})

it('keeps the pasted text when the clipboard also carries an image rendering of it', () => {
	expect(decidePaste({ ...base, text: 'table cells', fileCount: 1 })).toEqual({ action: 'default' })
	expect(decidePaste({ ...base, text: 'table cells', fileCount: 1, importDisabled: true })).toEqual(
		{
			action: 'default',
		},
	)
})

it('imports files when the clipboard has no text', () => {
	expect(decidePaste({ ...base, fileCount: 2 })).toEqual({ action: 'import' })
})

it('says why files were refused instead of swallowing them', () => {
	expect(decidePaste({ ...base, fileCount: 1, importDisabled: true })).toEqual({
		action: 'notice',
		notice: "Files can't be attached here.",
	})
	expect(
		decidePaste({ ...base, fileCount: 1, importDisabled: true, attachmentsSupported: false }),
	).toEqual({ action: 'notice', notice: "This engine doesn't take attachments yet." })
})
