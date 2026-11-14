import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	NotesError,
	buildNotes,
	fileFacts,
	isUnsigned,
	parseChangelog,
	run,
	sectionsFor,
} from '../feed-release-notes.mjs'

const CHANGELOG = `# @namzu/desktop

## 0.8.2

### Patch Changes

- 33b320e: Third change.

## 0.8.1

### Patch Changes

- 2a19c69: Second change.

## 0.8.0

### Minor Changes

- 3f4c78f: First paragraph of the big one.

  Second paragraph of the big one.

- ccf40c0: Another minor.

### Patch Changes

- aaaaaaa: A patch in the same version.

## 0.7.0

### Minor Changes

- bbbbbbb: Old.
`

const facts = { sha256: 'ab'.repeat(32), bytes: 5, megabytes: 506 }
const base = { file: 'Namzu-Setup-0.8.2.exe', facts }

test('several versions between previous and current, newest first, hashes removed', () => {
	const sections = sectionsFor(parseChangelog(CHANGELOG), '0.8.2', '0.7.0')
	assert.deepEqual(
		sections.map((s) => s.version),
		['0.8.2', '0.8.1', '0.8.0'],
	)
	const notes = buildNotes({
		...base,
		version: '0.8.2',
		previous: '0.7.0',
		sections,
		unsigned: false,
	})
	assert.match(notes, /### What's new since 0\.7\.0/)
	assert.ok(notes.indexOf('#### 0.8.2') < notes.indexOf('#### 0.8.1'))
	assert.ok(notes.indexOf('#### 0.8.1') < notes.indexOf('#### 0.8.0'))
	assert.doesNotMatch(notes, /33b320e|2a19c69|3f4c78f/)
	assert.doesNotMatch(notes, /Old\./)
	assert.match(notes, /- A patch in the same version\./)
})

test('no previous version lists only the current version', () => {
	const sections = sectionsFor(parseChangelog(CHANGELOG), '0.8.1', undefined)
	assert.deepEqual(
		sections.map((s) => s.version),
		['0.8.1'],
	)
	const notes = buildNotes({ ...base, version: '0.8.1', sections, unsigned: false })
	assert.match(notes, /### What's new in 0\.8\.1/)
	assert.doesNotMatch(notes, /since/)
})

test('a version missing from the changelog fails loudly', () => {
	assert.throws(() => sectionsFor(parseChangelog(CHANGELOG), '0.9.0', '0.8.0'), NotesError)
	assert.throws(() => sectionsFor(parseChangelog(CHANGELOG), '0.8.2', '0.8.2'), /not older/)
	assert.throws(() => sectionsFor(parseChangelog(CHANGELOG), 'v1', undefined), /not x\.y\.z/)
})

test('continuation paragraphs stay inside their bullet', () => {
	const [section] = sectionsFor(parseChangelog(CHANGELOG), '0.8.0', undefined)
	assert.equal(
		section.bullets[0],
		'First paragraph of the big one.\n\n  Second paragraph of the big one.',
	)
	const notes = buildNotes({ ...base, version: '0.8.0', sections: [section], unsigned: false })
	assert.match(
		notes,
		/- First paragraph of the big one\.\n\n {2}Second paragraph of the big one\.\n- Another minor\./,
	)
})

test('the unsigned section is present only while the build is unsigned', () => {
	assert.equal(isUnsigned('win:\n  # publisherName: Someone\n  target: nsis\n'), true)
	assert.equal(isUnsigned('win:\n  publisherName: Someone\n'), false)
	assert.equal(isUnsigned('win:\n  certificateSubjectName: X\n'), false)
	const sections = sectionsFor(parseChangelog(CHANGELOG), '0.8.2', '0.8.1')
	const unsigned = buildNotes({
		...base,
		version: '0.8.2',
		previous: '0.8.1',
		sections,
		unsigned: true,
	})
	const signed = buildNotes({
		...base,
		version: '0.8.2',
		previous: '0.8.1',
		sections,
		unsigned: false,
	})
	assert.match(unsigned, /### This preview is not code-signed/)
	assert.doesNotMatch(signed, /code-signed/)
})

test('SHA-256 and size come from the installer file', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'feed-notes-'))
	try {
		const data = Buffer.alloc(3 * 1048576, 7)
		const file = join(dir, 'Namzu-Setup-0.8.2.exe')
		await writeFile(file, data)
		const got = await fileFacts(file)
		assert.equal(got.sha256, createHash('sha256').update(data).digest('hex'))
		assert.equal(got.megabytes, 3)
		const changelog = join(dir, 'CHANGELOG.md')
		const config = join(dir, 'electron-builder.yml')
		const out = join(dir, 'notes.md')
		await writeFile(changelog, CHANGELOG)
		await writeFile(config, 'win:\n  target: nsis\n')
		await run([
			'--version',
			'0.8.2',
			'--previous',
			'0.8.1',
			'--installer',
			file,
			'--changelog',
			changelog,
			'--builder-config',
			config,
			'--out',
			out,
		])
		const notes = await readFile(out, 'utf8')
		assert.match(notes, new RegExp(got.sha256))
		assert.match(notes, /about 3 MB/)
		assert.match(notes, /Get-FileHash \.\\Namzu-Setup-0\.8\.2\.exe/)
		await assert.rejects(
			run([
				'--version',
				'0.9.9',
				'--installer',
				file,
				'--changelog',
				changelog,
				'--builder-config',
				config,
				'--out',
				out,
			]),
			NotesError,
		)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
