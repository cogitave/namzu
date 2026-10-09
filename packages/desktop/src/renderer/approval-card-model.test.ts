import { expect, it } from 'vitest'
import type { PermissionView } from '../shared/protocol.js'
import {
	FEEDBACK_NOTE_MAX,
	baseName,
	buildApprovalCard,
	declineFeedback,
	palMessageNote,
	summarizeInput,
} from './approval-card-model.js'

const request = (calls: PermissionView['calls']): PermissionView => ({
	id: 'r',
	sessionId: 's',
	projectId: 'p',
	calls,
})
const call = (
	name: string,
	input: unknown,
	extra: Partial<PermissionView['calls'][number]> = {},
): PermissionView['calls'][number] => ({
	id: `c-${name}`,
	name,
	input,
	isDestructive: false,
	...extra,
})

it('titles an edit with the file name, counts its lines and keeps the full path for the tooltip', () => {
	const model = buildApprovalCard(
		request([
			call(
				'edit',
				{ path: 'src/a.ts' },
				{
					preview: {
						path: '/work/src/a.ts',
						before: 'one\ntwo\nthree\n',
						after: 'one\nTWO\nthree\nfour\n',
					},
				},
			),
		]),
	)
	expect(model).toMatchObject({
		kind: 'edit',
		title: 'Edit a.ts?',
		fileName: 'a.ts',
		path: '/work/src/a.ts',
		added: 2,
		removed: 1,
		previewMissing: false,
	})
	expect(model.diff?.fragment).toBe(false)
})

it('calls a write to a new file Create, and a write over an existing one Write', () => {
	const created = buildApprovalCard(
		request([
			call(
				'write',
				{ path: 'n.md' },
				{ isDestructive: true, preview: { path: '/w/n.md', before: null, after: 'a\nb\n' } },
			),
		]),
	)
	expect(created).toMatchObject({ kind: 'create', title: 'Create n.md?', added: 2, removed: 0 })
	const over = buildApprovalCard(
		request([
			call(
				'write',
				{ path: 'n.md' },
				{ preview: { path: '/w/n.md', before: 'x\n', after: 'y\n' } },
			),
		]),
	)
	expect(over.title).toBe('Write n.md?')
})

it('falls back to the fragment in the call, labelled as no preview, when the engine sent none', () => {
	const model = buildApprovalCard(
		request([call('edit', { path: 'a.ts', old_string: 'foo', new_string: 'bar\nbaz' })]),
	)
	expect(model).toMatchObject({
		title: 'Edit a.ts?',
		previewMissing: true,
		diff: { before: 'foo\n', after: 'bar\nbaz\n', fragment: true },
		added: 2,
		removed: 1,
	})
	const batch = buildApprovalCard(
		request([
			call('edit', {
				path: 'a.ts',
				edits: [
					{ old_string: 'a', new_string: 'b' },
					{ old_string: 'c', new_string: 'd' },
				],
			}),
		]),
	)
	expect(batch.diff).toMatchObject({ before: 'a\nc\n', after: 'b\nd\n' })
	// A call with no usable change still names the file and says so.
	const bare = buildApprovalCard(request([call('edit', { path: 'a.ts' })]))
	expect(bare).toMatchObject({ title: 'Edit a.ts?', previewMissing: true })
	expect(bare.diff).toBeUndefined()
})

it('shows a command in a box and any other tool as readable pairs', () => {
	expect(
		buildApprovalCard(request([call('bash', { command: 'ls -la' }, { isDestructive: true })])),
	).toMatchObject({
		kind: 'command',
		title: 'Run this command?',
		command: 'ls -la',
		destructive: true,
	})
	const other = buildApprovalCard(
		request([
			call('web_fetch', {
				url: 'https://x.dev',
				maxBytes: 5,
				followRedirects: true,
				extra: { a: 1 },
			}),
		]),
	)
	expect(other.title).toBe('Allow web fetch?')
	expect(other.entries).toEqual([
		{ label: 'Url', value: 'https://x.dev' },
		{ label: 'Max bytes', value: '5' },
		{ label: 'Follow redirects', value: 'true' },
		{ label: 'Extra', value: '{"a":1}' },
	])
})

it('titles a delete, and lists the other calls of a batch', () => {
	const model = buildApprovalCard(
		request([call('delete_file', { path: 'old/x.ts' }), call('bash', { command: 'pnpm test' })]),
	)
	expect(model).toMatchObject({ kind: 'delete', title: 'Delete x.ts?', destructive: true })
	expect(model.others).toEqual(['Run pnpm test'])
})

it('reads a Windows path and a trailing slash as a file name', () => {
	expect(baseName('C:\\work\\src\\a.ts')).toBe('a.ts')
	expect(baseName('/work/dir/')).toBe('dir')
})

it('clips a long value and caps the pairs', () => {
	const entries = summarizeInput(
		Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 'v'.repeat(500)])),
	)
	expect(entries).toHaveLength(8)
	expect(entries[0]?.value.length).toBeLessThan(300)
	expect(summarizeInput('plain')).toEqual([{ label: 'Input', value: 'plain' }])
})

it('builds the note the model reads and leaves room for it inside the wire limit', () => {
	expect(declineFeedback('  use tabs  ')).toBe('The user declined this change and said: use tabs')
	expect(declineFeedback('x'.repeat(FEEDBACK_NOTE_MAX)).length).toBe(4000)
})

it('titles a message to a Pal with its name and shows the whole message, not a summary', () => {
	const body = `Check the build.\n${'detail '.repeat(100)}`
	const model = buildApprovalCard(
		request([call('send_pal_message', { palId: 'pal-1', body })]),
		new Map([['pal-1', 'Review']]),
	)
	expect(model).toMatchObject({
		kind: 'other',
		title: 'Message to Review',
		message: body,
		entries: [],
	})
	expect(model.destructive).toBe(false)
})

it('does not guess a Pal name it was not given, and never cuts a very long message', () => {
	const model = buildApprovalCard(
		request([call('send_pal_message', { palId: 'unknown', body: 'x'.repeat(5_000) })]),
		new Map([['pal-1', 'Review']]),
	)
	expect(model.title).toBe('Message to a Pal')
	expect(model.message).toBe('x'.repeat(5_000))
})

it('names a message to a Pal among the other calls one answer covers', () => {
	const model = buildApprovalCard(
		request([
			call('bash', { command: 'ls' }),
			call('send_pal_message', { palId: 'pal-1', body: 'Hi' }),
		]),
		new Map([['pal-1', 'Review']]),
	)
	expect(model.others).toEqual(['Message to Review'])
})

it('keeps the Pal name on a message so the card can say whose inbox it goes to', () => {
	const model = buildApprovalCard(
		request([call('send_pal_message', { palId: 'pal-1', body: 'Hi' })]),
		new Map([['pal-1', 'Işık']]),
	)
	expect(model.palName).toBe('Işık')
	expect(
		buildApprovalCard(request([call('send_pal_message', { palId: 'x', body: 'Hi' })])).palName,
	).toBeUndefined()
})

it('tells the person where an approved message goes, when it is read and how the Pal is started', () => {
	const note = palMessageNote('Işık')
	expect(note).toContain('Goes to Işık’s inbox.')
	expect(note).toContain('reads it the next time it runs')
	expect(note).toContain('does not start it')
	expect(note).toContain('namzu pal dispatch')
	expect(palMessageNote(undefined)).toContain('The Pal reads it the next time it runs')
})
