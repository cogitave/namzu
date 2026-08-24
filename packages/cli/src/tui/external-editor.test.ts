import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	ExternalEditorError,
	editDraftInExternalEditor,
	parseExternalEditorCommand,
	resolveExternalEditorCommand,
} from './external-editor.js'

const directories: string[] = []

afterEach(() => {
	for (const directory of directories.splice(0)) removeTempDir(directory)
})

function temporaryRoot(): string {
	const directory = mkdtempSync(join(tmpdir(), 'namzu-editor-test-'))
	directories.push(directory)
	return directory
}

describe('external editor command resolution', () => {
	it('prefers VISUAL and preserves quoted arguments without a shell', () => {
		expect(
			resolveExternalEditorCommand({
				VISUAL: '"C:\\Program Files\\Editor\\edit.exe" --wait "profile one"',
				EDITOR: 'ignored',
			}),
		).toEqual(['C:\\Program Files\\Editor\\edit.exe', '--wait', 'profile one'])
	})

	it('refuses missing and structurally incomplete commands', () => {
		expect(() => resolveExternalEditorCommand({})).toThrow(/set VISUAL or EDITOR/)
		expect(() => parseExternalEditorCommand('editor "unfinished')).toThrow(ExternalEditorError)
	})
})

describe('the host editor process', () => {
	it('receives the exact seed, returns edited text, and removes its private buffer', async () => {
		const root = temporaryRoot()
		const script = join(root, 'editor.mjs')
		writeFileSync(
			script,
			[
				"import { readFileSync, writeFileSync } from 'node:fs'",
				'const path = process.argv[2]',
				"writeFileSync(path, `${readFileSync(path, 'utf8')}\\nfrom editor\\n`)",
			].join('\n'),
		)

		const edited = await editDraftInExternalEditor('first\nsecond', {
			cwd: root,
			env: { ...process.env, VISUAL: `${process.execPath} "${script}"`, EDITOR: 'ignored' },
			temporaryRoot: root,
		})

		expect(edited).toBe('first\nsecond\nfrom editor\n')
		expect(readdirSync(root)).toEqual(['editor.mjs'])
	})

	it('refuses a non-zero editor without publishing replacement text', async () => {
		const root = temporaryRoot()
		const script = join(root, 'refuse.mjs')
		writeFileSync(script, 'process.exit(7)\n')

		await expect(
			editDraftInExternalEditor('keep me', {
				cwd: root,
				env: { ...process.env, VISUAL: '', EDITOR: `${process.execPath} "${script}"` },
				temporaryRoot: root,
			}),
		).rejects.toThrow('the editor exited with status 7')
		expect(readdirSync(root)).toEqual(['refuse.mjs'])
	})

	it('bounds the text read back from an editor-controlled file', async () => {
		const root = temporaryRoot()
		const script = join(root, 'oversized.mjs')
		writeFileSync(
			script,
			[
				"import { writeFileSync } from 'node:fs'",
				'writeFileSync(process.argv[2], Buffer.alloc(4 * 1024 * 1024 + 1))',
			].join('\n'),
		)

		await expect(
			editDraftInExternalEditor('seed', {
				cwd: root,
				env: { ...process.env, VISUAL: `${process.execPath} "${script}"` },
				temporaryRoot: root,
			}),
		).rejects.toThrow('the limit is 4,194,304')
		expect(readdirSync(root)).toEqual(['oversized.mjs'])
	})
})
