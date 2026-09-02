/**
 * `/release-notes`: what changed in the version that is running.
 *
 * The CHANGELOG ships in the package for this. Read next to package.json
 * so the notes are the installed version's, not whatever a checkout has.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CLI_VERSION } from './version.js'

export interface ReleaseNotes {
	readonly version: string
	/** The section body, without its `## version` heading. */
	readonly body: string
}

/** The `## <version>` section of a Changesets-style changelog, or null. */
export function changelogSection(changelog: string, version: string): ReleaseNotes | null {
	const lines = changelog.split('\n')
	const start = lines.findIndex((line) => line.trim() === `## ${version}`)
	if (start === -1) return null
	let end = lines.length
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i]?.startsWith('## ')) {
			end = i
			break
		}
	}
	const body = lines
		.slice(start + 1, end)
		.join('\n')
		.trim()
	return { version, body }
}

/** Every version the changelog has, newest first as written. */
export function changelogVersions(changelog: string): readonly string[] {
	return changelog
		.split('\n')
		.filter((line) => line.startsWith('## '))
		.map((line) => line.slice(3).trim())
}

export function readChangelog(): string | null {
	try {
		const here = dirname(fileURLToPath(import.meta.url))
		return readFileSync(join(here, '..', 'CHANGELOG.md'), 'utf8')
	} catch {
		return null
	}
}

export const RELEASE_NOTES_MAX_LINES = 80

/** The transcript text for `/release-notes [version]`. */
export function renderReleaseNotes(
	changelog: string | null,
	version: string = CLI_VERSION,
): string {
	if (changelog === null) {
		return 'No release notes: this install has no CHANGELOG.md beside its package.json.'
	}
	const section = changelogSection(changelog, version)
	if (!section) {
		const known = changelogVersions(changelog).slice(0, 8)
		return `No notes for ${version}. Versions with notes: ${known.join(', ')}${known.length < changelogVersions(changelog).length ? ', …' : ''}.`
	}
	const lines = section.body.split('\n')
	const shown = lines.slice(0, RELEASE_NOTES_MAX_LINES)
	const cut =
		lines.length > shown.length
			? `\n… ${lines.length - shown.length} more lines in CHANGELOG.md`
			: ''
	return `@namzu/cli ${section.version}\n\n${shown.join('\n')}${cut}`
}
