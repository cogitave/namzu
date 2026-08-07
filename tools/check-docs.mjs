#!/usr/bin/env node
// Fail the build when a document has drifted away from the thing it describes.
//
// Documentation in this repository follows the estate's documentation standard:
// markdown with YAML front matter, one concept per file, Diataxis content
// types. The front matter is the union of two contracts that the estate's own
// records already carry in a single header -- the identity and ownership fields
// of the documentation standard, and the portable knowledge-format fields. They
// compose rather than compete: the knowledge format reserves no key it does not
// define and requires consumers to preserve the rest.
//
// Five checks, all fatal:
//
//   FRONTMATTER   a doc in a migrated directory declares every required key,
//                 and `description` is a real sentence rather than a stub.
//   PROSE-STATUS  status belongs in front matter where a machine can read it. A
//                 sentence saying "Status: PROPOSAL" is invisible to every gate.
//   UID           `uid` is unique across the tree. Identity that collides is
//                 not identity, and the cross-reference graph is built on it.
//   RESOURCE      a doc's declared `resource:` path must exist. Documents
//                 outlive the code they point at.
//   DRIFT         if a doc's `resource:` has commits NEWER than the doc's own
//                 last commit, the code moved and the doc did not. This is
//                 causal, not a timer: a document whose subject nobody touched
//                 is never nagged.
//
// Choosing a `resource:` is the part that decides whether DRIFT is signal or
// noise. Point it at the narrowest artifact whose change would actually
// invalidate the document — a regression test that exists BECAUSE of the
// incident is usually the best answer, since it changes when the behaviour
// does and not otherwise. A barrel or an index file is the worst: it churns
// for unrelated reasons and trains everyone to wave the failure through.
// This gate's first real firing was exactly that mistake, on its own author.
// Where no single artifact owns the claim, omit `resource:` rather than
// inventing one; the field is optional and a wrong pointer is worse than none.
//
// DRIFT reads git history, so it REFUSES on a shallow clone rather than
// returning a pass it cannot justify. A gate whose precondition is absent must
// say "I cannot establish this", never "this is satisfied" -- see
// `docs/conventions/an-optional-dependency-may-not-degrade-a-check.md`, which
// is a rule this repository ratified after shipping exactly that defect.
//
// Scope is explicit and deliberately partial. `CONFORMING` lists the
// directories migrated to the standard so far; the gate is authoritative inside
// them and silent outside. Every run prints how many files are still outside,
// because a migration whose remainder is invisible is a migration that stops.
//
// Usage: node tools/check-docs.mjs [rootDir]

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * Paths migrated to the documentation standard — a directory, or a single file.
 *
 * Add an entry here in the same change that brings it up to the standard, never
 * before: an entry whose pages do not yet conform turns this gate red for
 * everyone, and an entry added "ready for later" is a check that cannot fail.
 *
 * Single files are allowed because a new page usually lands in a directory
 * whose other pages have not been migrated yet. Requiring a whole directory
 * would mean either migrating twenty unrelated pages to ship one, or leaving
 * the new page ungated — and the second is what actually happens.
 */
const CONFORMING = ['docs/conventions', 'docs/sdk/agent-directory.md']

/**
 * Front-matter keys every conforming document declares.
 *
 * `uid`, `owner` and `lastReviewed` come from the documentation standard;
 * `type`, `title`, `description`, `timestamp` and `status` from the portable
 * knowledge format; `diataxis` carries the writing discipline. `type` and
 * `diataxis` are separate on purpose -- `type` is what kind of thing the
 * document IS (a Convention, an ADR, a Reference) and `diataxis` is how it is
 * written. Collapsing them would restate one fact in two fields, which is the
 * drift class the estate's knowledge-propagation standard exists to forbid.
 *
 * Deliberately NOT required: `products`, `roles` and `level`. The documentation
 * standard lists them for the training-content pipeline, and no estate record
 * outside that pipeline carries them. Requiring a key nothing reads would be
 * the declared-but-undriven defect this repository names in its own rules.
 */
const REQUIRED_KEYS = [
	'uid',
	'title',
	'description',
	'type',
	'diataxis',
	'owner',
	'status',
	'timestamp',
	'lastReviewed',
]

/** The documentation standard's bounds for `description`. */
const DESCRIPTION_MIN = 75
const DESCRIPTION_MAX = 300

const PROPOSAL_STATES = new Set(['draft', 'proposal', 'proposed'])

/** Prose that is really a status field wearing a disguise. */
const PROSE_STATUS = /^\s*(?:\*\*)?status(?:\*\*)?\s*[:=]/i

const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..'))

const git = (args) =>
	execFileSync('git', args, {
		cwd: root,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
	}).trim()

/** Unix timestamp of the newest commit touching `path`, or 0 when untracked. */
function lastCommit(path) {
	try {
		return Number.parseInt(git(['log', '-1', '--format=%ct', '--', path]), 10) || 0
	} catch {
		return 0
	}
}

/**
 * Only the flat `key: value` subset is parsed -- deliberately, so a document
 * that needs more structure fails loudly here rather than being half-understood.
 */
function parseFrontMatter(text) {
	if (!text.startsWith('---')) return [{}, text]
	const end = text.indexOf('\n---', 3)
	if (end === -1) return [{}, text]
	const meta = {}
	for (const line of text.slice(3, end).split('\n')) {
		// Indented lines are nested YAML (a `verified:` list, say). This parser
		// reads the flat subset only, and a nested block's leaves are not keys.
		if (!line.trim() || /^[#\s]/.test(line)) continue
		const at = line.indexOf(':')
		if (at > 0) meta[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
	}
	return [meta, text.slice(end + 4)]
}

function* markdownUnder(dir) {
	if (!existsSync(dir)) return
	if (statSync(dir).isFile()) {
		if (dir.endsWith('.md')) yield dir
		return
	}
	const entries = readdirSync(dir, { withFileTypes: true })
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) yield* markdownUnder(full)
		else if (entry.name.endsWith('.md')) yield full
	}
}

const rel = (path) => relative(root, path).split('\\').join('/')

let problems = 0
const fail = (...lines) => {
	for (const l of lines) console.log(l)
	problems += 1
}

// `index.md` and `log.md` are reserved listing filenames in the knowledge
// format -- they describe a directory rather than a concept, so they carry no
// concept front matter. `README.md` is the same role under a name the code
// host renders.
const isListing = (path) => /\/(index|log|README)\.md$/.test(path)

// DRIFT cannot be established without history. Refuse rather than pass.
let shallow = false
try {
	shallow = git(['rev-parse', '--is-shallow-repository']) === 'true'
} catch {
	// Not a git repository at all -- DRIFT is simply not applicable, and that
	// is a different thing from history being truncated underneath us.
}

const uids = new Map()

for (const dir of CONFORMING) {
	for (const path of markdownUnder(join(root, dir))) {
		const where = rel(path)
		if (isListing(where)) continue

		const text = readFileSync(path, 'utf8')
		const [meta, body] = parseFrontMatter(text)

		// Keys are parsed lowercased so that `Title:` and `title:` are one key.
		// The required list keeps its canonical spelling for the message, so the
		// membership test has to lower it too -- otherwise `lastReviewed` can
		// never be found and the check reports every document as missing it.
		const missing = REQUIRED_KEYS.filter((k) => !(k.toLowerCase() in meta))
		if (missing.length) fail(`FRONTMATTER ${where}: missing ${missing.join(', ')}`)

		const len = (meta.description ?? '').length
		if (len && (len < DESCRIPTION_MIN || len > DESCRIPTION_MAX)) {
			const bounds = `${DESCRIPTION_MIN}-${DESCRIPTION_MAX}`
			fail(`FRONTMATTER ${where}: description is ${len} chars, must be ${bounds}`)
		}

		if (meta.uid) {
			const owner = uids.get(meta.uid)
			if (owner) fail(`UID ${where}: uid "${meta.uid}" already used by ${owner}`)
			else uids.set(meta.uid, where)
		}

		// Only the head of the body: a status header lives at the top. Further
		// down, "status = the StatusCode member" is prose ABOUT a field.
		for (const line of body.split('\n').slice(0, 15)) {
			if (PROSE_STATUS.test(line)) {
				fail(
					`PROSE-STATUS ${where}: ${line.trim().slice(0, 70)}`,
					'             put it in front matter as `status:` where a gate can read it',
				)
				break
			}
		}

		// A `resource:` may legitimately cite an external reference; only
		// repository paths can be checked for existence or drift.
		const resource = meta.resource
		if (!resource || /^https?:\/\//i.test(resource)) continue
		if (!existsSync(join(root, resource))) {
			fail(`RESOURCE ${where}: declares resource: ${resource}, which does not exist`)
			continue
		}

		if (shallow) continue
		const docAt = lastCommit(where)
		const resAt = lastCommit(resource)
		if (docAt && resAt > docAt) {
			const state = (meta.status ?? '').toLowerCase()
			const what = PROPOSAL_STATES.has(state)
				? 'a proposal whose code already shipped'
				: 'the code moved, the doc did not'
			fail(
				`DRIFT ${where}: ${what}`,
				`      ${resource} changed after this document was last touched`,
			)
		}
	}
}

if (shallow) {
	fail(
		'DRIFT: refusing to report on a shallow clone -- `git log` cannot see whether',
		'       a resource moved after its document, so a pass here would mean "I did',
		'       not look", not "nothing drifted". Check out with fetch-depth: 0.',
	)
}

// The remainder is debt, and it is printed every run so it stays visible.
const conforming = new Set()
for (const dir of CONFORMING) for (const p of markdownUnder(join(root, dir))) conforming.add(rel(p))
let outside = 0
for (const p of markdownUnder(join(root, 'docs'))) if (!conforming.has(rel(p))) outside += 1

console.log(`docs gate: ${problems} problem(s) across ${conforming.size} conforming file(s)`)
console.log(`           ${outside} file(s) under docs/ not yet migrated to the standard`)
process.exit(problems ? 1 : 0)
