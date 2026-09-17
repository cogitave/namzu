#!/usr/bin/env node
/**
 * Preflight for a root script whose entry point lives in a local-only package.
 *
 *   node scripts/check-local-entry.mjs [--root <dir>] <entry-point>...
 *
 * ## What it is for
 *
 * Four packages are local-only: `packages/contracts`, `packages/agents`,
 * `packages/api` and `packages/docs`. They are not in Git — `.gitignore` lists
 * them under "Local-only packages" — and `pnpm-workspace.yaml` excludes them
 * from the workspace, whose own comment explains why the two go together: the
 * packages are not Git-tracked, so CI never sees them, and leaving them as
 * workspace members would break Changesets config validation there. Both
 * halves matter, and a package named by one file and not the other is the
 * arrangement disagreeing with itself rather than a package that is local-only.
 *
 * The root `api` and `api:dev` scripts run one of them through `tsx`. Where
 * the package exists — the owner's working copy, not a fresh checkout — that
 * is the whole point, and the scripts must keep working there unchanged. In a
 * fresh clone, though, `tsx` reaches the import and reports
 * `ERR_MODULE_NOT_FOUND` naming a file — a message that reads as damage, and
 * says nothing about the absence being the arrangement. Nothing at that path
 * says "this package is deliberately not in Git"; the reader has to already
 * know.
 *
 * So a root script whose entry point is such a path runs this first, joined to
 * the real command with `&&`:
 *
 *   node scripts/check-local-entry.mjs packages/api/src/server.ts && tsx packages/api/src/server.ts
 *
 * ## The contract
 *
 *   - the entry point exists — print nothing, exit 0, and the command after
 *     the `&&` runs exactly as it would without this in front of it. Silently,
 *     because a preflight that chattered on every success would be noise in a
 *     `tsx watch` loop.
 *   - the entry point is missing — print one sentence naming the path and what
 *     is written down about it, exit 1. The `&&` stops there, so `tsx` is
 *     never reached and its unhelpful error is never the one a reader sees.
 *   - the invocation itself is wrong — no path, an empty path, an unknown
 *     flag, `-` — exit 2. An entry point that names nothing is not a check
 *     that passed: a preflight with nothing to check must not report success,
 *     which is why "do nothing when the arguments are odd" is not an option
 *     here, and why `-` is refused rather than read as a filename this script
 *     would then report missing on a path nobody meant.
 *
 * ## What the sentence claims, and where each claim comes from
 *
 * Every clause is read out of the file it names, because a sentence that
 * asserts an arrangement it did not check is worse than the bare error it
 * replaces: it sends the reader to a file with the wrong question.
 *
 *   - a path under the `.gitignore` block headed "Local-only packages" AND
 *     covered by a `pnpm-workspace.yaml` exclusion — one sentence naming both
 *     files, which is the shape the root `api` scripts produce.
 *   - a path under that block that `pnpm-workspace.yaml` does NOT exclude —
 *     the `.gitignore` clause alone. The two files disagree about that
 *     package, and the sentence says only what is there instead of quoting the
 *     other file into agreement.
 *   - a path under some other `.gitignore` entry (`dist/`, `coverage/`,
 *     `node_modules/`) — a weaker sentence: Git does not carry it and it is
 *     not a local-only package. `pnpm build` output called a local-only
 *     package is the same class of wrong answer this script exists to remove.
 *   - a path no entry covers — the weakest sentence, claiming no arrangement
 *     at all: the path is wrong, or the file was removed.
 *
 * ## --root
 *
 * `--root <dir>` points the check at another tree, defaulting to this script's
 * own repository. It exists for the tests, which need a tree whose local-only
 * packages are absent by construction rather than by whether the machine
 * running them happens to have them — and it is not a bypass: a run against
 * another root still checks, still exits 1, and still refuses an odd
 * invocation with 2.
 *
 * Entries are resolved against the root and then checked where they land. An
 * entry that escapes the tree — an absolute path, or enough `..` — is therefore
 * checked against the file it actually names, and passes if that file exists:
 * nothing here claims an entry stays inside the root it is being checked
 * against, and refusing such an entry would refuse the absolute paths that are
 * a legitimate way to call this.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')

const USAGE = 'usage: node scripts/check-local-entry.mjs [--root <dir>] <entry-point>...'

/** The heading `.gitignore` puts over the packages this arrangement is about. */
const LOCAL_ONLY_HEADING = /^#.*\blocal-only packages\b/i

function readIfPresent(path) {
	try {
		return readFileSync(path, 'utf8')
	} catch {
		return null
	}
}

/**
 * What `.gitignore` says, in the two shapes this script distinguishes.
 *
 * `ignored` is every directory the file excludes — `packages/api`, `dist`,
 * `node_modules`, whichever block they are written in — matched as a path
 * prefix. A trailing slash is stripped rather than required: `.gitignore`
 * reads `packages/api` and `packages/api/` the same way, and a parser that
 * understood only the slashed spelling would quietly lose the whole property
 * if the entry were ever respelled.
 *
 * `localOnly` is the narrower set: the entries inside the block headed
 * "Local-only packages". That block, not the general ignore list, is what the
 * phrase "local-only package" in the message refers to — `dist/` is ignored,
 * and is not one.
 *
 * Negated (`!`) entries re-include rather than exclude, comments are comments,
 * and a wildcard pattern is skipped rather than approximated: a glob cannot be
 * matched as a path prefix, and guessing at one would be this script asserting
 * an arrangement it had not read.
 */
function gitignore(root) {
	const ignored = []
	const localOnly = []
	const text = readIfPresent(join(root, '.gitignore'))
	if (text === null) return { ignored, localOnly }

	let inLocalOnlyBlock = false
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim()
		if (line === '') {
			inLocalOnlyBlock = false
			continue
		}
		if (line.startsWith('#')) {
			inLocalOnlyBlock = LOCAL_ONLY_HEADING.test(line)
			continue
		}
		if (line.startsWith('!') || line.includes('*')) continue
		const entry = line.replace(/^\//, '').replace(/\/+$/, '')
		if (entry === '') continue
		if (!ignored.includes(entry)) ignored.push(entry)
		if (inLocalOnlyBlock && !localOnly.includes(entry)) localOnly.push(entry)
	}
	return { ignored, localOnly }
}

/**
 * The packages `pnpm-workspace.yaml` keeps out of the workspace, as written:
 * a negated glob (`- "!packages/api"`), normalized to `packages/api`. A file
 * the script cannot read contributes no exclusions, which is what makes the
 * message claim an exclusion only where it found one.
 */
function workspaceExclusions(root) {
	const patterns = []
	const text = readIfPresent(join(root, 'pnpm-workspace.yaml'))
	if (text === null) return patterns

	for (const match of text.matchAll(/^\s*-\s*"(![^"]+)"\s*$/gm)) {
		const pattern = match[1].replace(/^!/, '').replace(/\/+$/, '')
		if (pattern !== '' && !patterns.includes(pattern)) patterns.push(pattern)
	}
	return patterns
}

/**
 * The longest entry in `entries` that covers `rel`, or null when none does.
 * Longest, so a narrow entry describes the path even when a broader one is
 * also present, and null rather than a guessed default, so a path no entry
 * covers is never described by one that does not.
 */
function covering(entries, rel) {
	let best = null
	for (const entry of entries) {
		if (rel !== entry && !rel.startsWith(`${entry}/`)) continue
		if (best === null || entry.length > best.length) best = entry
	}
	return best
}

/** Whether a workspace exclusion covers `path`, a directory or a file inside one. */
function excludedFromWorkspace(patterns, path) {
	return patterns.some((pattern) => {
		const dir = pattern.replace(/\/\*$/, '').replace(/\/+$/, '')
		return dir !== '' && (path === dir || path.startsWith(`${dir}/`))
	})
}

function missingSentence(rel, ignoredEntry, isLocalOnly, excluded) {
	if (ignoredEntry === null) {
		return `${rel} is missing: no .gitignore entry covers it and it is under no pnpm-workspace.yaml exclusion, so this is not the local-only arrangement — the path is wrong, or the file was removed.`
	}
	if (!isLocalOnly) {
		return `${rel} is missing: .gitignore excludes ${ignoredEntry}/, so the path is generated or installed rather than committed, and a fresh checkout does not contain it.`
	}
	const workspace = excluded ? ' and excluded from the workspace in pnpm-workspace.yaml' : ''
	return `${rel} is missing: ${ignoredEntry} is a local-only package, listed under "Local-only packages" in .gitignore${workspace}, so a fresh checkout does not contain it.`
}

function parseArgs(argv) {
	let root = REPO_ROOT
	const entries = []
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === '--root') {
			const value = argv[index + 1]
			if (value === undefined || value === '') return { problem: `--root needs a directory\n${USAGE}` }
			root = resolve(process.cwd(), value)
			index += 1
			continue
		}
		if (arg === '') return { problem: `an entry point cannot be an empty string\n${USAGE}` }
		if (arg.startsWith('-')) return { problem: `unknown option: ${arg}\n${USAGE}` }
		entries.push(arg)
	}
	if (entries.length === 0) return { problem: USAGE }
	return { root, entries }
}

const parsed = parseArgs(process.argv.slice(2))
if (parsed.problem !== undefined) {
	console.error(parsed.problem)
	process.exit(2)
}

const { ignored, localOnly } = gitignore(parsed.root)
const exclusions = workspaceExclusions(parsed.root)
let missing = 0

for (const entry of parsed.entries) {
	const absolute = isAbsolute(entry) ? entry : resolve(parsed.root, entry)
	if (existsSync(absolute)) continue
	missing += 1
	const rel = relative(parsed.root, absolute).split(sep).join('/')
	const ignoredEntry = covering(ignored, rel)
	const isLocalOnly = ignoredEntry !== null && localOnly.includes(ignoredEntry)
	console.error(missingSentence(rel, ignoredEntry, isLocalOnly, excludedFromWorkspace(exclusions, ignoredEntry ?? rel)))
}

process.exit(missing === 0 ? 0 : 1)
