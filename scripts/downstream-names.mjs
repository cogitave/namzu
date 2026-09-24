/**
 * Names of a downstream consumer: where the list comes from, and the matcher
 * two checks share (issue #530).
 *
 * namzu is a standalone project, and a product that builds on it is not part
 * of its story. That product's name, its environment variables, its cloud
 * resources, the ids in its notes and the paths in its repository mean nothing
 * to the next reader — and where they ship, in a runtime error, a `.d.ts` doc
 * comment or a CHANGELOG inside the tarball, every installer reads them. Say
 * "the host", "the consumer", "a self-hosted orchestrator", or use a
 * placeholder such as `acme`.
 *
 * Two checks read with this matcher:
 *
 *  - `scripts/audit-external-names.mjs` refuses a listed name anywhere in the
 *    tree: every inventoried text file, string literals, CHANGELOGs,
 *    changesets, Dockerfiles and JSON included, and every file's path.
 *  - `scripts/check-downstream-names.mjs` refuses one in what a pull request
 *    carries outside the tree — its title, its body, its head branch's name,
 *    its commit messages and each commit's author and committer — and in the
 *    lines and paths each of its commits adds.
 *
 * ## Where the list lives
 *
 * In the environment variable `NAMZU_DOWNSTREAM_NAMES`, and in no file of this
 * repository in any form. CI fills it from the repository secret of the same
 * name, and passes it only to the steps that run these checks; AGENTS.md says
 * how the owner maintains it. A committed list is the trace the checks exist to
 * remove, and a committed list of DIGESTS is one too: a product's name is a
 * short, guessable word, and hashing the words of this repository's own
 * history recovered every entry of such a list in seconds.
 *
 * The value is plain names, one per line or separated by commas. Blank entries
 * are ignored. An entry is one of:
 *
 *  - `Some Name` — the default. It matches whatever its case, separator,
 *    full-width or accented form, and inside identifiers; see below.
 *  - `word=exact` — one word, matched only when a whole word of the text is
 *    that word, compared without case (and after the same width, accent and
 *    invisible-character folding). It is never split into parts, so it is not
 *    found inside `wordHost`, `WORD_TLS_CA` or `word_id`, nor in `words`. It is
 *    for a name that is also an ordinary word, whose parts would otherwise
 *    turn up in unrelated identifiers. A dash, a dot, a slash or a space still
 *    ends a word, so `word-side` and `/var/lib/word/` match. Ordinary prose that
 *    uses the word on its own still matches: nothing can tell the name from
 *    the word there.
 *
 * An entry that could never match, or would match ordinary words — one shorter
 * than four characters once folded, more than four parts, an `=exact` entry
 * of more than one word, an option other than `=exact` — is refused, and
 * named only by its position in the list, never by its text.
 *
 * ## Without the list
 *
 *  - In CI, for a pull request from a fork, GitHub gives the run no
 *    secrets. The rule is skipped there, with a notice that says why; the
 *    External-name audit in release.yml, which runs on every push to `main`
 *    whatever else it skips, reads the tree with the list before anything is
 *    published.
 *  - Everywhere else — a pull request from a branch of this repository, a
 *    merge group, a push, a release run, a local run — the check fails with
 *    `NAMZU_DOWNSTREAM_NAMES is not set`. A gate that goes quiet when its
 *    input is missing is green exactly when it is switched off.
 *  - Locally, a contributor without access to the list passes
 *    `--without-downstream-names`: the rest of the audit runs, and the output
 *    says this rule did not. The flag is refused in CI (`GITHUB_ACTIONS` is
 *    `true`), so no workflow can carry it.
 *
 * ## What a default entry matches
 *
 * Text is read one line at a time, as words: runs of letters, digits,
 * combining marks and underscores. Each word is folded — compatibility forms
 * (full-width letters, ligatures) to their plain letters, accents and invisible
 * format characters (a soft hyphen, a zero-width space) removed — and split
 * into parts at underscores, at a change of case (`nameHost`, `NAMEHost`) and
 * between letters and digits (`name042`). Parts are lowercased with the
 * locale-independent Unicode mapping, never the machine's locale.
 *
 * A name is the concatenation of its own parts, so `Some Name`, `some_name`,
 * `SomeName`, `some-name`, `SOME.NAME` and `somename` are one entry. The check
 * compares every run of one to `MAX_PARTS` consecutive parts that are either in
 * one word or in words joined only by a space, a dash or a dot. So a name is
 * found inside `NAME_TLS_CA`, `nameHost`, `name-side` or `/var/lib/name/`, and
 * a longer word that merely begins with it — `names`, `namesake` — is another
 * word and is not.
 *
 * What it does not match: a name spelled with look-alike letters from another
 * script, split by other punctuation (`na/me`), or across a line break.
 *
 * ## What the output says
 *
 * Never the name, and never the variable's value. This repository's CI logs
 * are public, and a failure that printed the line it refused would publish the
 * name in the log. GitHub masks a secret's exact value in a log; it does not
 * mask one entry of it in another spelling.
 *
 * So each check prints every line through `printable`, which does two things.
 * It redacts: every word carrying a listed name reads `***`. And it refuses:
 * a line that, once redacted, still contains an entry's text anywhere — say,
 * as the start of a longer word the matcher rightly does not count — is not
 * printed at all, and a placeholder saying so is printed instead. That holds
 * for everything a check prints, not only its own findings: the tree audit
 * also runs the product-name rule, whose report quotes the line and the path
 * it flagged, and either check can fail on a file or an event whose path
 * carries a name. A line is cut to length only after it is redacted
 * (`excerpt`), since a cut through the middle of a name would leave a fragment
 * no entry equals. An error about the list names an entry by its position.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** The environment variable, and the repository secret, that carries the list. */
export const NAMES_VARIABLE = 'NAMZU_DOWNSTREAM_NAMES'

/** The local opt-out, for a contributor without access to the list. */
export const OPT_OUT_OPTION = 'without-downstream-names'
export const OPT_OUT_FLAG = `--${OPT_OUT_OPTION}`

/** The most parts a name may have, and so the longest run the check compares. */
export const MAX_PARTS = 4

/** The shortest folded name an entry may have: shorter ones match ordinary words. */
const MIN_LENGTH = 4

// A word, and the characters that may join two words into one name.
const WORD = /[\p{L}\p{N}\p{M}\p{Pc}\p{Cf}]+/gu
const JOINER = /^[\p{Zs}\t\p{Pd}.]{1,3}$/u
// The parts of a folded word. Every letter is Lu, Ll, Lt, Lm or Lo, so every
// letter and digit lands in exactly one part; underscores and anything else
// the fold produced are dropped.
const PART = /\p{Lu}+(?!\p{Ll})|\p{Lu}?\p{Ll}+|\p{N}+|[\p{Lt}\p{Lm}\p{Lo}]+/gu
const DROPPED = /[\p{M}\p{Cf}]/gu

/** Text with compatibility forms, accents and format characters folded, lowercased. */
const foldText = (text) => text.normalize('NFKD').replace(DROPPED, '').toLowerCase()

/** Each word's parts and whole fold, once: the tree holds the same words many times. */
const partsCache = new Map()
const wholeCache = new Map()

/** The lowercased parts of one word, after folding it. */
function partsOf(word) {
	let parts = partsCache.get(word)
	if (parts === undefined) {
		const folded = word.normalize('NFKD').replace(DROPPED, '')
		parts = []
		for (const [part] of folded.matchAll(PART)) parts.push(part.toLowerCase())
		partsCache.set(word, parts)
	}
	return parts
}

/** One word folded whole, never split: what an `=exact` entry is compared with. */
function wholeOf(word) {
	let whole = wholeCache.get(word)
	if (whole === undefined) {
		whole = foldText(word)
		wholeCache.set(word, whole)
	}
	return whole
}

/**
 * A default entry as the check sees it: its parts, concatenated. Throws when
 * no text could ever be refused for it, or when it would refuse ordinary words.
 */
function foldName(name) {
	const parts = []
	for (const [word] of name.matchAll(WORD)) parts.push(...partsOf(word))
	if (parts.length === 0) throw new Error('it has no letters or digits')
	if (parts.length > MAX_PARTS) {
		throw new Error(`it has ${parts.length} parts, and the check joins at most ${MAX_PARTS}`)
	}
	const folded = parts.join('')
	if (folded.length < MIN_LENGTH) {
		throw new Error(
			`it is shorter than ${MIN_LENGTH} characters once folded, and would match ordinary words`,
		)
	}
	return folded
}

/** An `=exact` entry as the check sees it: one word, folded whole. */
function foldExact(name) {
	const words = [...name.matchAll(WORD)]
	if (words.length !== 1 || words[0][0] !== name) {
		throw new Error(
			'an `=exact` entry is one word of letters, digits and underscores, with no space, dash or dot',
		)
	}
	const folded = foldText(name)
	if (!/[\p{L}\p{N}]/u.test(folded)) throw new Error('it has no letters or digits')
	if (folded.length < MIN_LENGTH) {
		throw new Error(
			`it is shorter than ${MIN_LENGTH} characters once folded, and would match ordinary words`,
		)
	}
	return folded
}

/**
 * The list in `value`: names separated by newlines or commas, each optionally
 * followed by `=exact`. An empty value is an empty list. Throws on an entry no
 * text could be refused for, naming it only by its position.
 *
 * `names` holds the default entries' folds, `exact` the `=exact` ones';
 * `needles` is what `printable` refuses to print: every entry as typed and as
 * folded.
 */
export function parseNames(value) {
	const list = { names: new Set(), exact: new Set(), needles: new Set(), longest: 0, size: 0 }
	const entries = value
		.split(/[\r\n,]+/)
		.map((entry) => entry.trim())
		.filter((entry) => entry !== '')
	entries.forEach((entry, index) => {
		const at = entry.indexOf('=')
		const name = (at === -1 ? entry : entry.slice(0, at)).trim()
		const option =
			at === -1
				? undefined
				: entry
						.slice(at + 1)
						.trim()
						.toLowerCase()
		try {
			if (option !== undefined && option !== 'exact') {
				throw new Error('the only option an entry takes is `=exact`')
			}
			if (option === 'exact') {
				const folded = foldExact(name)
				list.exact.add(folded)
				list.needles.add(folded)
			} else {
				const folded = foldName(name)
				list.names.add(folded)
				list.longest = Math.max(list.longest, folded.length)
				list.needles.add(folded)
				list.needles.add(foldText(name))
			}
		} catch (error) {
			throw new Error(`entry ${index + 1} of ${NAMES_VARIABLE} cannot be used: ${error.message}`)
		}
	})
	list.size = list.names.size + list.exact.size
	return list
}

/** The list of placeholder entries given, for the matcher's own cases and for tests. */
export const listOfNames = (entries) => parseNames(entries.join('\n'))

/**
 * Whether this is a CI run for a pull request from a fork:
 * the one run GitHub gives no secrets to. Read from the event that triggered
 * the run, never from anything the pull request chose. Anything unreadable
 * answers no, and the caller then fails rather than skips.
 */
function isForkPullRequest(env) {
	if (env.GITHUB_EVENT_NAME !== 'pull_request' || !env.GITHUB_EVENT_PATH) return false
	let pr
	try {
		pr = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))?.pull_request
	} catch {
		return false
	}
	const base = pr?.base?.repo?.full_name
	if (typeof base !== 'string' || base === '') return false
	// A fork deleted since the pull request opened has no `head.repo` at all.
	return pr?.head?.repo?.full_name !== base
}

/**
 * The list a check runs with, or why it runs without one. One of:
 *
 *  - `{ list }` — `NAMZU_DOWNSTREAM_NAMES` holds names;
 *  - `{ list, skip }` — it is empty, and this is either a CI run for a
 *    pull request from a fork or a local run given `--without-downstream-names`;
 *    `skip` is the line to print, and `list` is empty;
 *  - `{ fail }` — anything else; the caller prints it and exits 2.
 *
 * Throws on an entry the list cannot use.
 */
export function resolveDownstreamNames({ env = process.env, optOut = false } = {}) {
	const inActions = env.GITHUB_ACTIONS === 'true'
	if (optOut && inActions) {
		return {
			fail: `${OPT_OUT_FLAG} is for a local checkout without access to the list. In GitHub Actions the list is the ${NAMES_VARIABLE} secret, and this rule always runs.`,
		}
	}
	const list = parseNames(env[NAMES_VARIABLE] ?? '')
	if (list.size > 0) return { list }
	if (inActions && isForkPullRequest(env)) {
		return {
			list,
			skip: `::notice title=Downstream names skipped::${NAMES_VARIABLE} is not set: this run is for a pull request from a fork, and GitHub gives such a run no secrets, so the downstream-name rule did not run here. The External-name audit in release.yml reads the tree with the list on every push to main, before anything is published.`,
		}
	}
	if (inActions) {
		return {
			fail: `${NAMES_VARIABLE} is not set. This run did not receive the repository secret of that name, and the downstream-name rule does not pass over a list it did not get. A maintainer sets it with \`gh secret set ${NAMES_VARIABLE}\` (AGENTS.md says how).`,
		}
	}
	if (optOut) {
		return {
			list,
			skip: `Downstream-name rule not run: ${NAMES_VARIABLE} is not set and ${OPT_OUT_FLAG} was given. CI runs it with the list.`,
		}
	}
	return {
		fail: `${NAMES_VARIABLE} is not set. The downstream-name rule reads its list from that variable (names separated by newlines or commas), which CI fills from the repository secret. Without access to the list, pass ${OPT_OUT_FLAG} to run everything else; CI still runs this rule.`,
	}
}

/**
 * The words of `text` that carry a listed name, as `[start, end]` offsets, in
 * order. A run of parts that equals a default entry marks every word it
 * touches; a word that is an `=exact` entry, folded whole, marks itself.
 */
function listedWords(text, list) {
	if (list.size === 0) return []
	const words = []
	const parts = []
	const marked = new Set()
	let previousEnd = -1
	for (const match of text.matchAll(WORD)) {
		const start = match.index
		const end = start + match[0].length
		const joined = previousEnd >= 0 && JOINER.test(text.slice(previousEnd, start))
		const word = words.length
		words.push([start, end])
		if (list.exact.size > 0 && list.exact.has(wholeOf(match[0]))) marked.add(word)
		partsOf(match[0]).forEach((part, index) => {
			parts.push({ part, word, joined: index > 0 || joined })
		})
		previousEnd = end
	}
	if (list.names.size > 0) {
		for (let first = 0; first < parts.length; first += 1) {
			let folded = ''
			for (let last = first; last < parts.length && last - first < MAX_PARTS; last += 1) {
				if (last > first && !parts[last].joined) break
				folded += parts[last].part
				if (folded.length > list.longest) break
				if (!list.names.has(folded)) continue
				for (let word = parts[first].word; word <= parts[last].word; word += 1) marked.add(word)
			}
		}
	}
	return [...marked].sort((a, b) => a - b).map((word) => words[word])
}

/** Whether any word of `text` carries a listed name. */
export const namesIn = (text, list) => listedWords(text, list).length > 0

/** `text` with every word that carries a listed name printed as `***`. */
export function redact(text, list) {
	let out = ''
	let at = 0
	for (const [start, end] of listedWords(text, list)) {
		out += `${text.slice(at, start)}***`
		at = end
	}
	return out + text.slice(at)
}

/** What is printed in place of a line `printable` refuses. */
export const WITHHELD = `(line withheld: it would print part of ${NAMES_VARIABLE})`

/**
 * `line` as a check may print it: redacted, and withheld whole, keeping only
 * its indentation, if an entry's text is still anywhere in what is left. The
 * one function every line a check prints goes through.
 */
export function printable(line, list) {
	const redacted = redact(line, list)
	if (list.size === 0) return redacted
	const folded = foldText(redacted)
	for (const needle of list.needles) {
		if (folded.includes(needle)) return `${/^\s*/.exec(line)[0]}${WITHHELD}`
	}
	return redacted
}

/**
 * Lines deliberately kept although they carry a listed name, by the SHA-256 of
 * the whole trimmed line: the licence covers that exact sentence and nothing
 * written beside it. This is a digest of a line the tree carries verbatim, not
 * of a name, so it tells a reader nothing the tree does not.
 *
 *  - The release note for the `ToolCatalogSurface` member rename, identical in
 *    three CHANGELOGs. A consumer upgrading across that release needs the old
 *    member value it quotes to find its call sites, so issue #530 keeps it.
 */
const KEPT_LINE_DIGESTS = new Set([
	'3d73bbc86b5e4579d2bfc6844d0c5f43c2401d2bb162775946799d5af1d7f50a',
])

const keptLineDigest = (line) =>
	createHash('sha256').update(`namzu/kept-line:${line.trim()}`).digest('hex')

/**
 * One line as a report quotes it: trimmed, redacted, then cut to 140
 * characters. Redacting first is the point: cut first, a name straddling the
 * cut would be printed in part.
 */
export const excerpt = (line, list) => redact(line.trim(), list).slice(0, 140)

/**
 * Every line of `text` that carries a listed name, numbered from 1, with the
 * names redacted. A kept line is skipped.
 */
export function findingsIn(text, list) {
	const hits = []
	if (list.size === 0) return hits
	text.split('\n').forEach((line, index) => {
		if (!namesIn(line, list) || KEPT_LINE_DIGESTS.has(keptLineDigest(line))) return
		hits.push({ line: index + 1, text: excerpt(line, list) })
	})
	return hits
}

/** How a failing check tells the author what to write instead. */
export const REMEDY =
	'namzu names no product built on it; say "the host" or "the consumer", or use a placeholder such as `acme`'

/**
 * The matcher's own cases, with placeholders standing in for listed names so
 * that this table names no one.
 */
const CASE_NAMES = ['acme', 'note_042', 'Zyx Corp', 'pixo', 'zorblax=exact']
const MATCH_CASES = [
	// Where the names in issue #530 actually sat.
	["'(the host must supply ACME_SANDBOX_FC_TLS_CA in network mode)'", true],
	['hostPath: "/var/lib/acme/sessions/<task>/outputs"', true],
	['over the PUBLIC internet (the `ca-acme-app` hop)', true],
	["labels: { 'acme.task-id': 't1' }", true],
	['driven by the Acme-side lifecycle', true],
	['const acmeHost = 1', true],
	['class AcmeSupervisor {}', true],
	['material (note_042 P4)', true],
	// Spellings of one name.
	['session NOTE-042 again', true],
	['session note042 again', true],
	['the zyxcorp app', true],
	['the ZyxCorp app', true],
	['the zyx-corp app', true],
	['the ZYX.CORP app', true],
	['the zyx corp app', true],
	['the zyx_corp app', true],
	['the ＡＣＭＥ console', true],
	['the Ácme console', true],
	['the ac­me console', true],
	['the İACME console', false],
	// Words that are not the name.
	['an acmeish word is another word', false],
	['material (note_0420 P4)', false],
	['material (note 42)', false],
	['the host must supply the config field', false],
	['the zyx/corp app', false],
	['zyx\ncorp', false],
	// An `=exact` entry: the whole word, in any case, and nothing inside one.
	['the zorblax is calm', true],
	['The Zorblax.', true],
	['the ZORBLAX-side lifecycle', true],
	['under /var/lib/zorblax/ today', true],
	['the Ｚｏｒｂｌａｘ console', true],
	['the zor­blax console', true],
	['const zorblaxHost = 1', false],
	['supply ZORBLAX_TLS_CA here', false],
	['a zorblax_id field', false],
	['two zorblaxes', false],
	['the zor-blax app', false],
	['the zor blax app', false],
]
const REDACTION_CASES = [
	["labels: { 'acme.task-id': 't1' }", "labels: { '***.task-id': 't1' }"],
	['supply ACME_SANDBOX_FC_TLS_CA here', 'supply *** here'],
	['the acmeish Acme-side host', 'the acmeish ***-side host'],
	['the Zyx Corp team', 'the *** *** team'],
	['a Zorblax-side zorblaxHost', 'a ***-side zorblaxHost'],
]
const PRINT_CASES = [
	['the Acme-side host', 'the ***-side host'],
	['    the acmeish Acme-side host', `    ${WITHHELD}`],
	['the zorblaxHost field', WITHHELD],
	['nothing listed here', 'nothing listed here'],
]

/**
 * What the matcher gets wrong about its own cases; empty when nothing. Both
 * checks assert it before reading anything, because a matcher that disagrees
 * with its own table makes their verdict about the text meaningless.
 */
export function matcherSelfCheck() {
	const broken = []
	for (const digest of KEPT_LINE_DIGESTS) {
		if (!/^[0-9a-f]{64}$/.test(digest)) broken.push(`not a SHA-256 hex digest: ${digest}`)
	}
	const cases = listOfNames(CASE_NAMES)
	for (const [text, expected] of MATCH_CASES) {
		if (namesIn(text, cases) !== expected) {
			broken.push(`${expected ? 'should flag' : 'should ignore'}: ${JSON.stringify(text)}`)
		}
	}
	for (const [text, expected] of REDACTION_CASES) {
		const actual = redact(text, cases)
		if (actual !== expected) broken.push(`should redact to ${expected}: ${actual}`)
	}
	for (const [text, expected] of PRINT_CASES) {
		const actual = printable(text, cases)
		if (actual !== expected) broken.push(`should print as ${expected}: ${actual}`)
	}
	return broken
}
