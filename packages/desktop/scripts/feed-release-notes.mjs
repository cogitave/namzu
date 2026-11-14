#!/usr/bin/env node
// Writes the Markdown notes of the rolling release `desktop-latest` (the update feed of Namzu
// Desktop) for the installer being published, so the page a person opens to download the app
// describes the version it carries.
//
//   node feed-release-notes.mjs --version 0.8.4 [--previous 0.8.0] --installer <Namzu-Setup-x.exe> \
//        [--changelog CHANGELOG.md] [--builder-config electron-builder.yml] [--out notes.md]
//
// --previous is the newest installer already on the feed, if any. The notes list every changelog
// section after it up to --version, newest first. A version that has no changelog section is an
// error: empty notes are never written. Without --out the notes go to stdout.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export class NotesError extends Error {}

const fail = (message) => {
	throw new NotesError(message)
}

const VERSION = /^\d+\.\d+\.\d+$/

function assertVersion(label, value) {
	if (typeof value !== 'string' || !VERSION.test(value)) fail(`${label} "${value}" is not x.y.z`)
}

export function compareVersions(a, b) {
	const x = a.split('.').map(Number)
	const y = b.split('.').map(Number)
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
	return 0
}

/**
 * Reads changesets' CHANGELOG.md into [{ version, bullets }]. Each bullet is the text of one
 * "- <short sha>: text" entry without its hash, with its indented continuation lines (and the
 * blank lines between them) kept, indented so they stay part of the list item.
 */
export function parseChangelog(text) {
	const sections = []
	let section = null
	let bullet = null
	const closeBullet = () => {
		if (!bullet) return
		while (bullet.length > 1 && bullet[bullet.length - 1] === '') bullet.pop()
		section.bullets.push(bullet.join('\n'))
		bullet = null
	}
	for (const line of text.split(/\r?\n/)) {
		const heading = /^## (\d+\.\d+\.\d+)\s*$/.exec(line)
		if (heading) {
			closeBullet()
			section = { version: heading[1], bullets: [] }
			sections.push(section)
			continue
		}
		if (!section) continue
		if (/^#{1,3} /.test(line)) {
			closeBullet()
			continue
		}
		const item = /^- (?:[0-9a-f]{7,40}: )?(.*)$/.exec(line)
		if (item) {
			closeBullet()
			bullet = [item[1]]
		} else if (bullet && (line === '' || /^\s+\S/.test(line))) {
			bullet.push(line === '' ? '' : `  ${line.trimStart()}`)
		} else {
			closeBullet()
		}
	}
	closeBullet()
	return sections
}

/** The sections after `previous` (all of `version`'s own when there is none) up to `version`, newest first. */
export function sectionsFor(sections, version, previous) {
	assertVersion('version', version)
	if (previous !== undefined) {
		assertVersion('previous version', previous)
		if (compareVersions(previous, version) >= 0) {
			fail(`the feed already holds ${previous}, which is not older than ${version}`)
		}
	}
	const own = sections.find((s) => s.version === version)
	if (!own || own.bullets.length === 0) fail(`CHANGELOG.md has no entry for ${version}`)
	return sections
		.filter(
			(s) =>
				s.bullets.length > 0 &&
				compareVersions(s.version, version) <= 0 &&
				(previous === undefined ? s.version === version : compareVersions(s.version, previous) > 0),
		)
		.sort((a, b) => compareVersions(b.version, a.version))
}

/** Signed means electron-builder.yml names a publisher or a certificate on a line that is not a comment. */
export function isUnsigned(builderConfig) {
	const live = builderConfig
		.split(/\r?\n/)
		.filter((l) => !/^\s*#/.test(l))
		.join('\n')
	return !/^\s*(publisherName|certificateFile|certificateSubjectName|certificateSha1|azureSignOptions|signtoolOptions|cscLink)\s*:/m.test(
		live,
	)
}

export async function fileFacts(path) {
	const hash = createHash('sha256')
	for await (const chunk of createReadStream(path)) hash.update(chunk)
	const { size } = await stat(path)
	return {
		sha256: hash.digest('hex'),
		bytes: size,
		megabytes: Math.max(1, Math.round(size / 1048576)),
	}
}

export function buildNotes({ version, previous, file, facts, sections, unsigned }) {
	const out = []
	out.push(`## Namzu Desktop ${version}`, '')
	out.push(
		'The desktop app for working with AI agents: projects, conversations, Pals with their own computer, and the Namzu terminal agent bundled in.',
		'',
	)
	out.push(
		'If you already have Namzu Desktop installed, it updates itself to this version, so there is nothing to download again. For a new install, download the setup file below.',
		'',
	)
	out.push(
		`**Download (new install):** \`${file}\` below (about ${facts.megabytes} MB). Windows 10 or 11, 64-bit.`,
		'',
	)
	out.push(`SHA-256: \`${facts.sha256}\``)
	out.push(`To check it in PowerShell: \`Get-FileHash .\\${file}\``, '')
	out.push(previous ? `### What's new since ${previous}` : `### What's new in ${version}`, '')
	for (const section of sections) {
		if (sections.length > 1) out.push(`#### ${section.version}`, '')
		for (const b of section.bullets) out.push(`- ${b}`)
		out.push('')
	}
	if (unsigned) {
		out.push(
			'### This preview is not code-signed',
			'',
			'Windows warns you before the first run. That is expected for this preview.',
			'- **"Windows protected your PC"**: choose **More info**, then **Run anyway**.',
			'- **"Open File - Security Warning"** with "Unknown Publisher": choose **Run**.',
			'',
		)
	}
	return `${out.join('\n').trimEnd()}\n`
}

function parseArgs(argv) {
	const args = {}
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i]
		if (!key?.startsWith('--') || argv[i + 1] === undefined) fail(`bad argument: ${key ?? ''}`)
		args[key.slice(2)] = argv[i + 1]
	}
	return args
}

export async function run(argv) {
	const here = dirname(fileURLToPath(import.meta.url))
	const args = parseArgs(argv)
	const version = args.version
	const previous = args.previous || undefined
	if (!args.installer) fail('--installer is required')
	const changelog = await readFile(args.changelog ?? join(here, '..', 'CHANGELOG.md'), 'utf8')
	const builder = await readFile(
		args['builder-config'] ?? join(here, '..', 'electron-builder.yml'),
		'utf8',
	)
	const sections = sectionsFor(parseChangelog(changelog), version, previous)
	const notes = buildNotes({
		version,
		previous,
		file: basename(args.installer),
		facts: await fileFacts(args.installer),
		sections,
		unsigned: isUnsigned(builder),
	})
	if (args.out) await writeFile(resolve(args.out), notes)
	else process.stdout.write(notes)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	run(process.argv.slice(2)).catch((error) => {
		process.stderr.write(
			`${error instanceof NotesError ? error.message : (error?.stack ?? error)}\n`,
		)
		process.exit(1)
	})
}
