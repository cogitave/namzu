#!/usr/bin/env node
/**
 * Create the GitHub Releases the changesets action could not.
 *
 * The action inlines a package's whole changelog entry as the release body,
 * and GitHub rejects a body over 125,000 characters. A release that batches
 * many changesets crosses that on the largest package and the step fails —
 * *after* the publish, so the packages are on the registry and only the
 * release notes are missing. The last one lost `@namzu/sdk@3.0.0`'s
 * release while its ten siblings got theirs.
 *
 * Truncating is the whole job. The full text is already committed at
 * `packages/<pkg>/CHANGELOG.md` and reachable at the tag, so a body that
 * keeps each entry's opening line and links the rest loses nothing a
 * reader cannot get in one click.
 *
 * Runs after the action, over every tag it pushed. A tag that already has
 * a release is left alone, so this is additive: if it breaks, the releases
 * the action DID create still stand.
 *
 * Usage: node .github/scripts/backfill-github-releases.mjs [--dry-run]
 * Requires: `gh` authenticated, run from the repo root, tags fetched.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const BODY_LIMIT = 125_000
const DRY_RUN = process.argv.includes('--dry-run')

function sh(cmd, args) {
	return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
}

/** Tags pointing at HEAD — what this release just published. */
function tagsAtHead() {
	try {
		return sh('git', ['tag', '--points-at', 'HEAD'])
			.split('\n')
			.map((t) => t.trim())
			.filter((t) => t.startsWith('@namzu/'))
	} catch {
		return []
	}
}

function hasRelease(tag) {
	try {
		execFileSync('gh', ['release', 'view', tag, '--json', 'tagName'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

/** `@namzu/sdk@3.0.0` -> `{ pkg: '@namzu/sdk', version: '3.0.0' }` */
function parseTag(tag) {
	const at = tag.lastIndexOf('@')
	return { pkg: tag.slice(0, at), version: tag.slice(at + 1) }
}

/** Where a package's manifest lives, by reading each one rather than guessing. */
function manifestDirFor(pkgName) {
	const dirs = sh('git', ['ls-files', 'packages/**/package.json'])
		.split('\n')
		.map((f) => f.trim())
		.filter(Boolean)
	for (const file of dirs) {
		try {
			if (JSON.parse(readFileSync(file, 'utf8')).name === pkgName) return file.replace(/\/package\.json$/, '')
		} catch {
			// unreadable manifest is not this package's problem
		}
	}
	return undefined
}

/** The changelog section for one version, verbatim. */
function changelogEntry(dir, version) {
	const path = join(dir, 'CHANGELOG.md')
	if (!existsSync(path)) return undefined
	const text = readFileSync(path, 'utf8')
	const start = text.indexOf(`## ${version}`)
	if (start < 0) return undefined
	const next = text.indexOf('\n## ', start + 3)
	return text.slice(start, next < 0 ? undefined : next).trim()
}

/**
 * A body that fits, keeping every entry's opening line.
 *
 * Dropping the indented prose rather than cutting at a character offset is
 * what keeps the result readable: a mid-sentence cut reads as corruption,
 * and the reader cannot tell whether anything after it existed.
 */
function summarize(entry, link) {
	const kept = []
	for (const line of entry.split('\n')) {
		if (line.startsWith('### ')) kept.push('', line, '')
		else if (/^- [0-9a-f]{7}: /.test(line)) kept.push(line.replace(/^- [0-9a-f]{7}: /, '- '))
	}

	const head = [
		`This entry is ${entry.length.toLocaleString('en-US')} characters — past GitHub's ${BODY_LIMIT.toLocaleString('en-US')}-character limit for a release body, so it is summarized here.`,
		'',
		`**[Read the full changelog](${link})**`,
		'',
		'---',
	].join('\n')

	let body = `${head}\n${kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
	if (body.length > BODY_LIMIT) {
		body = `${body.slice(0, BODY_LIMIT - 200).trimEnd()}\n\n… truncated. [Read the full changelog](${link})\n`
	}
	return body
}

// `--tag` names a tag explicitly instead of reading HEAD's. Two uses: an
// operator backfilling one release by hand, and proving the summarize path
// against a real oversized entry without waiting for a release big enough
// to trigger it.
const forced = process.argv.filter((a) => a.startsWith('--tag=')).map((a) => a.slice('--tag='.length))
const candidates = forced.length > 0 ? forced : tagsAtHead()
const missing = candidates.filter((tag) => DRY_RUN || !hasRelease(tag))
if (missing.length === 0) {
	console.log('✓ every tag at HEAD already has a GitHub release')
	process.exit(0)
}

console.log(`${missing.length} tag(s) without a release: ${missing.join(', ')}`)

let failed = 0
for (const tag of missing) {
	const { pkg, version } = parseTag(tag)
	const dir = manifestDirFor(pkg)
	if (!dir) {
		console.error(`  ✗ ${tag}: no package directory found for ${pkg}`)
		failed++
		continue
	}

	const entry = changelogEntry(dir, version)
	if (!entry) {
		console.error(`  ✗ ${tag}: no \`## ${version}\` section in ${dir}/CHANGELOG.md`)
		failed++
		continue
	}

	const link = `https://github.com/cogitave/namzu/blob/${encodeURIComponent(tag)}/${dir}/CHANGELOG.md`
	const body = entry.length > BODY_LIMIT ? summarize(entry, link) : entry
	const note = entry.length > BODY_LIMIT ? `summarized from ${entry.length} chars` : 'verbatim'

	if (DRY_RUN) {
		console.log(`  · ${tag}: would create (${body.length} chars, ${note})`)
		continue
	}

	const file = join(tmpdir(), `release-body-${Date.now()}-${failed}.md`)
	writeFileSync(file, body)
	try {
		execFileSync('gh', ['release', 'create', tag, '--title', tag, '--notes-file', file, '--verify-tag'], {
			stdio: 'inherit',
		})
		console.log(`  ✓ ${tag} (${body.length} chars, ${note})`)
	} catch {
		console.error(`  ✗ ${tag}: gh release create failed`)
		failed++
	}
}

if (failed > 0) {
	console.error(`\n${failed} release(s) could not be created.`)
	process.exit(1)
}
