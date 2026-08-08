#!/usr/bin/env node
/**
 * Refuse a third-party product name in a comment or an identifier.
 *
 * The rule namzu holds: nothing in this codebase takes its NAMING from
 * another system, and no brand appears in prose — not in a doc comment, not
 * in an inline one, not in a symbol. A design explained by reference to
 * somebody else's product is a design that has borrowed its shape, and the
 * borrowing outlives the sentence: the next reader reaches for that
 * system's model instead of this one's.
 *
 * What this does NOT flag, and must not:
 *
 *  - **Wire values.** A context-window table keyed by model id has to
 *    contain real model ids or it resolves nothing; a driver registry has
 *    to name the service it drives. These are data namzu carries in order
 *    to interoperate, and deleting them would delete the feature.
 *  - **Package and import paths.** A driver package for a service is named
 *    after the service; that is its identity, not a borrowed idea.
 *  - **String literals.** A driver id in a switch, a model id in a test
 *    fixture, an env-var name a provider actually reads — all of them are
 *    values that cross a boundary. Scanning literals was tried and it
 *    flagged those everywhere, which would have meant exempting half the
 *    tree; a rule that broad enforces nothing.
 *
 * The distinction is the whole point: a name in a string that crosses the
 * wire is interoperability, and the same name in a sentence explaining why
 * the code looks the way it does is an admission that it was copied.
 *
 * The one thing this cannot catch is a brand inside PROMPT text, which is
 * prose that happens to live in a literal. There is no general way to tell
 * that from a wire value, so it is a review question rather than a rule —
 * and the identity prompt, the only place it arose, now names no one.
 *
 * ## What it does not enforce, measured 2026-08-08
 *
 * Issue #220 widened WHERE this looks. That is the smaller half of the hole,
 * and leaving the rest unwritten would let a green run read as a rule that is
 * kept. It is not one.
 *
 * **Respelling walks through.** This matches literal spellings, so every
 * multi-token brand crushed into one entry here is evaded by writing it the way
 * prose actually writes it. Eleven variants were tried against the real script
 * and all eleven passed: a space (`lang chain`, `crew ai`, `chat gpt`, `auto
 * gen`, `llama index`, `open ai`), a hyphen, and an initialism. The sharpest
 * case is `huggingface`: the spaced form is the brand's OWN standard spelling,
 * so for that entry the list is simply spelled wrong for matching. This is a
 * design question — normalise the haystack, or carry real variants per brand —
 * not a lexical patch, and it is filed rather than guessed at here.
 *
 * **Four channels bypass every entry equally**, all confirmed by running this:
 *
 *  - a fenced code block, including one inside a doc comment;
 *  - an inline backtick span;
 *  - a markdown link TARGET (the link TEXT is still scanned, and is caught);
 *  - a string or template literal.
 *
 * Only the last was previously written down. All four are the same trade: each
 * exists because that construct is overwhelmingly a value rather than prose,
 * and each is therefore a place a positioning sentence can sit unenforced. They
 * are accepted, not closed — and an accepted gap that is recorded is a
 * decision, while the same gap unrecorded is a surprise for whoever trusts the
 * green.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()

/**
 * Product and project names that must not appear in prose or identifiers.
 *
 * Matched case-insensitively on a word boundary, so `openaiCompatible`
 * is caught while `open` is not.
 *
 * An entry may instead be `{ name, collidesWithEnglish: true }`, which means
 * the spelling is also an ordinary English word this codebase uses correctly.
 * Those match only Title-Case away from the start of a sentence, or ALL-CAPS —
 * see `matches`. It is data rather than a special case in the code, so the next
 * collision is one line here instead of a new branch there.
 *
 * **Flagging an entry is a narrowing**: a lowercase mid-sentence mention of
 * that product stops being caught. It is worth it only where the ordinary sense
 * is genuinely written here, because a rule that cries wolf on correct prose is
 * a rule somebody switches off — and then it catches nothing at all.
 */
const FORBIDDEN = [
	'anthropic',
	'claude',
	'chatgpt',
	'openai',
	'langchain',
	'langgraph',
	'llamaindex',
	'autogen',
	'crewai',
	// Issue #217. `strands` is a verb this codebase uses correctly about an
	// orphaned session, and the sentence that first tripped the rule was a
	// sentence ABOUT the rule tripping.
	{ name: 'strands', collidesWithEnglish: true },
	'vercel',
	// 'cursor' is deliberately absent: it collides with the pagination
	// cursor this codebase threads through every list call, and a rule that
	// cries wolf on a correct word gets switched off.
	'copilot',
	'gemini',
	'mistral',
	// Found while fixing #217, by running the matcher rather than reading it:
	// "the plan should cohere with the roadmap" is flagged today. Shipping a fix
	// billed as general while leaving this would be fixing one instance of a
	// class and calling the class done.
	{ name: 'cohere', collidesWithEnglish: true },
	'huggingface',
	'pydantic',
	'semantic kernel',
	// Hosting and sandbox services namzu does NOT drive. They appeared as
	// POSITIONING — "the platforms that ship this tier", "that is their
	// entire product" — which is the most persuasive form of the thing this
	// rule refuses: prose that explains namzu's shape by pointing at
	// somebody else's. Deliberately absent from this list: 'render' and
	// 'railway' collide with ordinary words (`render` a template) and would
	// cry wolf, and 'docker' / 'firecracker' / 'azure' name mechanisms a
	// backend actually drives, which is a wire value.
	'northflank',
	'replit',
	'daytona',
	'e2b',
	'gvisor',
	'fly machines',
	// Measured when the scan reached `.github/` (issue #220): this phrase
	// appears nowhere in the repository, and the workflows name their actions
	// and runners as `actions/checkout@v5`, `ubuntu-latest` and the like, which
	// this does not match. So no exemption is added for it — one would be a
	// guard whose condition can never be false today.
	//
	// What would make it real: a workflow or doc naming the CI platform in
	// prose, as the honest self-reference of a repository that runs on it. That
	// is a path-or-context exemption, not a lexical one, and it should be
	// written when there is a line to point at.
	'github actions',
]

/**
 * Entries with an ordinary sense that were considered for
 * `collidesWithEnglish` and deliberately left without it (#217, measured
 * 2026-08-08). Recorded because an unflagged entry looks identical whether the
 * question was asked or never occurred to anyone.
 *
 *  - `anthropic` ("the anthropic principle"), `copilot` ("the copilot seat"),
 *    `autogen` ("// autogen: do not edit"), `semantic kernel` (a real term in
 *    NLP). The ordinary sense is available in English and is not written HERE,
 *    while the lowercase spelling is how people actually write those products —
 *    so flagging them would cost real detection to prevent a false positive
 *    nobody has had. One line each if that ever changes. `anthropic` and
 *    `cohere` are additionally in `DRIVEN_SERVICES`, so for those two the
 *    exposure is source comments only; doc prose is already exempt.
 *  - `mistral` collides with the wind, which is commonly capitalised too, so
 *    the guard would not separate the senses. It is not a candidate.
 *
 * Three entries are UNGUARDABLE and are escalated rather than decided here:
 * `claude`, `gemini` and `daytona` each collide with another PROPER NOUN — a
 * person's name, a space programme, a place — so both senses are capitalised
 * and there is no casing signal left to use. Removing them is the only
 * remaining option and it loosens the owner's hardest rule, which makes it the
 * owner's call and not this file's. None of them has produced a false positive
 * here; they are listed so the next reader inherits the analysis.
 */

/**
 * `FORBIDDEN` normalised to one shape, so nothing downstream has to ask whether
 * an entry is a string or an object.
 */
const TERMS = FORBIDDEN.map((entry) =>
	typeof entry === 'string' ? { name: entry, collidesWithEnglish: false } : entry,
)

/** Directories whose contents are never scanned, matched by name at any depth. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.turbo'])

/**
 * Directories skipped by their path from the root rather than by name.
 *
 * `.claude/worktrees/` holds agent worktrees, and a worktree is a **whole
 * second copy of this repository under a different path prefix**. Every
 * exemption in this file is matched on a path — `packages/providers/`, the
 * wire-value list — so inside a worktree none of them match, and the driver
 * packages that are exempt by design get re-reported as violations. Scanning it
 * is not extra coverage: it is the same files audited with the rules switched
 * off.
 *
 * Measured before adding: with one agent worktree present the run emitted 566
 * findings, **every one** of them from `.claude/worktrees/` and none from the
 * repository. The gate failed on a developer machine for a reason that had
 * nothing to do with the tree it was auditing, and a gate that fails for a
 * phantom is one people learn to run with `|| true`.
 *
 * By path and not by name, deliberately, and **not** `.claude/` as a whole:
 * eight skill files under `.claude/skills/` are tracked prose that this audit
 * is exactly about. Skipping the parent to silence the child would have traded
 * a phantom failure for a real blind spot — the shape issue #220 was about.
 */
const SKIP_PATHS = new Set(['.claude/worktrees'])

/**
 * Files exempt from the identifier rule because their whole purpose is to
 * speak another party's protocol or name another party's service.
 *
 * The exemption is per FILE and deliberately narrow: a driver package
 * exists to drive one service, and a wire-value table exists to carry wire
 * values. Everything else — the kernel, the runtime, the tools — has no
 * business naming anyone.
 */
const WIRE_VALUE_FILES = [
	'packages/providers/',
	'packages/sdk/src/compaction/context-window.ts',
	'packages/sdk/src/provider/registry.ts',
	// A classifier whose whole job is to recognise OTHER parties' error
	// shapes: which field carries the status, where the headers hang, what
	// each client calls an overload. Naming them is the interoperability,
	// exactly like a model-id table.
	'packages/sdk/src/provider/errors.ts',
	'packages/sdk/src/types/provider/config.ts',
	'packages/sdk/src/types/computer-use/index.ts',
	'packages/sdk/src/tools/builtins/computer-use.ts',
	'packages/computer-use/src/',
	'packages/cli/src/integrations/',
	// A sandbox backend drives one containment mechanism and has to speak
	// its API — the same category as a provider driver. The exemption stops
	// at `backends/`: the package's own public surface is prose about
	// namzu's tiers, and that is where the positioning had accumulated.
	'packages/sandbox/src/backends/',
]

const isWireValueFile = (path) => WIRE_VALUE_FILES.some((prefix) => path.startsWith(prefix))

/**
 * File kinds this scans, and what each is written in.
 *
 * The `.ts`/`.tsx`/`.md` set is what the rule was born with. The rest arrived
 * with issue #220: an install script, a workflow and a hook are authored
 * material in exactly the sense a source comment is, and a product name in one
 * of them passed CI while still breaking the rule. A gate reporting green over
 * a directory it never opened is worse than no gate, because a green run gets
 * taken as an answer.
 */
const JS_FAMILY = /\.(ts|tsx|mjs|cjs|js)$/
const SHELL_FAMILY = /\.(sh|ps1|ya?ml)$/
const SCANNED = /\.(ts|tsx|md|mjs|cjs|js|sh|ps1|ya?ml)$/

/**
 * Which language's comment syntax a file uses.
 *
 * Only three answers matter: markdown has its own prose rules, the JS family
 * comments with `//`, and everything else here — shell, PowerShell, YAML and
 * the extension-less git hooks — comments with `#`.
 */
function familyOf(path) {
	if (path.endsWith('.md')) return 'markdown'
	if (JS_FAMILY.test(path)) return 'js'
	return 'shell'
}

/**
 * The git hooks carry as much rationale prose as any source file and have no
 * extension at all, so they are named rather than matched.
 */
const isHook = (path) => path.split('/').includes('.husky')

async function* walk(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (SKIP_DIRS.has(entry.name)) continue
		const full = join(dir, entry.name)
		const posix = relative(ROOT, full).split(sep).join('/')
		if (SKIP_PATHS.has(posix)) continue
		if (entry.isDirectory()) {
			yield* walk(full)
			continue
		}
		if (SCANNED.test(entry.name) || isHook(full.split(sep).join('/'))) yield full
	}
}

/**
 * Markdown files whose prose is ABOUT naming a service.
 *
 * The published page for a driver has to say which service it drives and
 * which model ids it takes, exactly like the driver source does. A
 * `CHANGELOG` is a record of what shipped, generated from release notes:
 * rewriting it would be editing history to match a rule it predates.
 */
const WIRE_VALUE_DOCS = [
	'packages/providers/',
	'docs/providers/',
	// Credential discovery: the page's subject IS which stored credentials
	// namzu can read, and a keychain item has the name it has. Same
	// rationale as the CLI integration source, already exempt above.
	'docs/cli/providers.md',
]

const isWireValueDoc = (path) =>
	path.endsWith('CHANGELOG.md') || WIRE_VALUE_DOCS.some((prefix) => path.startsWith(prefix))

/**
 * Services namzu ships a driver for, allowed in published PROSE only.
 *
 * A user-facing page has a job the source does not: telling an operator
 * which services namzu can talk to. "Use this package for that API" is
 * interoperability written down, the same category as the driver's own
 * name — and a catalogue that refuses to say what it connects to is
 * useless to the person deciding whether to install it.
 *
 * Source comments get no such licence, and neither do the product names
 * around these APIs. A comment explains why namzu's own code has its
 * shape, and a vendor is never that reason; `claude`, `chatgpt`, `gemini`
 * and `copilot` are assistants namzu does not drive, so naming one is
 * positioning wherever it appears.
 */
const DRIVEN_SERVICES = new Set([
	'anthropic',
	'openai',
	'bedrock',
	'openrouter',
	'ollama',
	'mistral',
	'cohere',
])

/**
 * Strip what markdown uses for the same job a string literal does in code.
 *
 * An inline code span is a package path, a symbol, a model id, a CLI
 * argument — a value the reader is meant to type verbatim, not a sentence
 * explaining namzu by pointing at somebody else. A fenced block is a code
 * sample, already exempt on the source side for the same reason. Link
 * TARGETS go too: a URL is an address, and the rule is about prose.
 */
function stripMarkdownCode(line) {
	return line
		.replace(/`[^`]*`/g, '``')
		.replace(/\]\([^)]*\)/g, ']()')
		.replace(/https?:\/\/\S+/g, '')
}

/**
 * Strip string and template literals, leaving comments and code.
 *
 * Crude on purpose: a real parse would be more precise and this rule is
 * about prose, where the crude version is exact. A false positive here
 * costs one glance; a false negative ships a borrowed name.
 *
 * This applies to the shell family too, and deliberately. Quoting is how
 * shell says "this is a literal value", which is the same statement a
 * TypeScript string literal makes — so `DEPENDENTS=('anthropic' 'bedrock')`
 * is a list of package identities and reads as one here.
 */
function stripStringLiterals(line) {
	return line
		.replace(/'(?:[^'\\]|\\.)*'/g, "''")
		.replace(/"(?:[^"\\]|\\.)*"/g, '""')
		.replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/**
 * A path under `packages/providers/` is identity, not prose.
 *
 * The script already skips `import` and `export … from` lines because a
 * package path is the package's name rather than a borrowed idea. A shell
 * `for` loop over package directories, or a YAML matrix listing them, is that
 * same statement in a language with no import syntax — so `providers/anthropic`
 * in `for pkg in … providers/anthropic …` is exempt for the reason the import
 * line always was.
 *
 * Two restrictions, and both matter. It applies only to the shell family,
 * and only on a line that is NOT a comment. Without them this is a laundering
 * mechanism: a sentence whose only occurrence of a forbidden name sits inside a
 * path — "we took our backoff constants directly from packages/providers/…" —
 * would newly pass, and that is precisely the shape the rule exists to catch.
 * Code names paths. Prose does not get to hide behind one.
 */
const WORKSPACE_PACKAGE_PATH = /\b(?:packages\/)?providers\/[a-z0-9][a-z0-9.-]*/g

/**
 * Title-case every word of a term: `semantic kernel` -> `Semantic Kernel`.
 *
 * This used to be `name.charAt(0).toUpperCase() + name.slice(1)`, which
 * capitalises only the first letter of the whole phrase and therefore produced
 * `Semantic kernel` — a spelling no brand uses. That was inert while both
 * branches below were case-insensitive or identifier-only, and it stops being
 * inert the moment a multi-word entry is given the English-collision guard: the
 * guard would match a form nobody writes, and the entry would silently stop
 * catching its own brand while the gate went on reporting green.
 *
 * The transform is pinned by `DISCRIMINATOR_CASES` below rather than trusted.
 */
function titleCase(name) {
	return name.replace(/(^|\s)(\w)/g, (_m, lead, ch) => lead + ch.toUpperCase())
}

/**
 * Whether a name sits at the start of its sentence on this line.
 *
 * Only used for the English-collision guard. Leading comment openers, list
 * bullets and heading marks are punctuation rather than words, so a name after
 * one of them is still the first word of what it is saying.
 *
 * A line-wrapped comment defeats it — a sentence continuing onto the next line
 * looks like a fresh one. That direction is a miss rather than a false alarm,
 * which is the direction this whole guard is choosing.
 */
function startsASentence(haystack, index) {
	const before = haystack
		.slice(0, index)
		.replace(/^[\s>]*(?:\/\/+|\/\*+|\*+|#+|[-+]|\d+[.)])?[\s>*+-]*/, '')
	return before === '' || /[.!?:]\s+$/.test(before)
}

/**
 * Whether a forbidden name appears as a name rather than inside a word.
 *
 * Two ways it can: standing alone (`\bopenai\b`), or as a camelCase or
 * PascalCase segment (`openaiCompatible`, `AnthropicClient`). Neither of
 * those is negotiable — a borrowed name concatenated into an identifier is
 * still a borrowed name.
 *
 * What must NOT match is an ordinary English word that happens to begin
 * with one: `coherent` starts with `cohere`, and `strands` is a verb this
 * codebase uses correctly about an orphaned session. A rule that cries
 * wolf on correct prose is a rule somebody switches off, and then it
 * catches nothing at all.
 *
 * The camelCase branch was made case-sensitive for exactly that reason. The
 * standalone branch was not, and that is what issue #217 is: `\bstrands\b`
 * with the `i` flag fires on the verb. So does `\bcohere\b` on "the plan should
 * cohere with the roadmap" — measured, not theorised. An entry flagged
 * `collidesWithEnglish` gets the same discipline on the standalone branch:
 * Title-Case not at the start of a sentence, or ALL-CAPS anywhere.
 */
function matches(term, haystack) {
	const escaped = term.name.replace(/ /g, '\\s+')
	const titled = titleCase(term.name).replace(/ /g, '\\s+')

	if (term.collidesWithEnglish) {
		// ALL-CAPS is never the ordinary English sense in running prose, so it
		// needs no position test.
		if (new RegExp(`\\b${term.name.toUpperCase().replace(/ /g, '\\s+')}\\b`).test(haystack)) {
			return true
		}
		const standalone = new RegExp(`\\b${titled}\\b`, 'g')
		for (let hit = standalone.exec(haystack); hit; hit = standalone.exec(haystack)) {
			if (!startsASentence(haystack, hit.index)) return true
		}
	} else if (new RegExp(`\\b${escaped}\\b`, 'i').test(haystack)) {
		return true
	}

	// Case-SENSITIVE, deliberately. A camelCase boundary is defined by the
	// change of case, so an `i` flag turns `[A-Z]` into `[A-Za-z]` and the
	// rule starts matching any word that merely begins with the name —
	// `coherent` for `cohere`, `stranded` for `strands`. That false
	// positive is exactly how a rule like this gets switched off.
	return (
		new RegExp(`\\b${escaped}(?=[A-Z0-9_-])`).test(haystack) ||
		new RegExp(`\\b${titled}(?=[A-Z0-9_-])`).test(haystack)
	)
}

/**
 * The discriminator's own cases, asserted on every run before anything is
 * scanned.
 *
 * `scripts/` has no test runner and no package would pick one up here, so the
 * alternative to this table is a matcher whose two opposing requirements —
 * catch the brand, ignore the English word — are defended by nothing. A guard
 * that quietly stops matching is the failure this file exists to prevent, so it
 * is not left to argument.
 *
 * A disagreement exits 2 rather than 1, so a broken discriminator is never read
 * as a clean tree.
 */
const DISCRIMINATOR_CASES = [
	// The two entries the guard is for. Issue #217 is the first line here.
	['we modelled this on Strands', 'strands', true],
	['the run strands the session', 'strands', false],
	['Strands of the retry loop share one lock.', 'strands', false],
	['we modelled this on STRANDS', 'strands', true],
	['unlike Cohere, this ships no hosted endpoint', 'cohere', true],
	['the plan should cohere with the roadmap', 'cohere', false],
	['a coherent design', 'cohere', false],
	// Unguarded entries keep matching any case, including the ordinary sense.
	// That is the trade, and it is written here so it is visible rather than
	// discovered.
	['we copied OpenAI function-calling', 'openai', true],
	['openaiCompatible', 'openai', true],
	['an open standard', 'openai', false],
	['the copilot seat', 'copilot', true],
	// Multi-word entries, which is what the title-case repair is for.
	['we copied Semantic Kernel planner design', 'semantic kernel', true],
	['we copied Fly Machines API design', 'fly machines', true],
]

/** Pins the transform itself; the first-letter-only version fails line one. */
const TITLE_CASE_CASES = [
	['semantic kernel', 'Semantic Kernel'],
	['fly machines', 'Fly Machines'],
	['github actions', 'Github Actions'],
	['strands', 'Strands'],
]

function selfCheck() {
	const broken = []
	for (const [input, expected] of TITLE_CASE_CASES) {
		const actual = titleCase(input)
		if (actual !== expected) broken.push(`titleCase(${input}) = ${actual}, expected ${expected}`)
	}
	for (const [text, name, expected] of DISCRIMINATOR_CASES) {
		const term = TERMS.find((t) => t.name === name)
		if (!term) {
			broken.push(`no forbidden entry named ${name}`)
			continue
		}
		const actual = matches(term, text)
		if (actual !== expected) {
			broken.push(`[${name}] ${expected ? 'should flag' : 'should ignore'}: ${text}`)
		}
	}
	if (broken.length === 0) return
	console.error('the name matcher disagrees with its own cases:\n')
	for (const line of broken) console.error(`  ${line}`)
	console.error('\nThis is the discriminator being wrong, not the tree being dirty.')
	process.exit(2)
}

function findings(source, path) {
	// Exempt outright. These files exist to name a service or to carry its
	// wire values, including in the examples that show how to use them;
	// auditing them would mean auditing the interoperability itself.
	if (isWireValueFile(path)) return []

	const family = familyOf(path)
	const isMarkdown = family === 'markdown'
	if (isMarkdown && isWireValueDoc(path)) return []

	const hits = []
	let inFence = false
	// YAML frontmatter is metadata: `related_packages` is a list of package
	// identifiers, which is identity rather than prose.
	let inFrontmatter = isMarkdown && source.startsWith('---')

	source.split('\n').forEach((line, index) => {
		if (inFrontmatter) {
			if (index > 0 && line.trim() === '---') inFrontmatter = false
			return
		}
		// A fenced block inside a doc comment is a code sample — API usage,
		// which is the same category as a wire value, not prose.
		if (line.includes('```')) {
			inFence = !inFence
			return
		}
		if (inFence) return

		// Import paths are identity, not prose.
		if (/^\s*import\s|^\s*export\s.*\sfrom\s/.test(line)) return

		if (isMarkdown) {
			const prose = stripMarkdownCode(line)
			for (const term of TERMS) {
				if (DRIVEN_SERVICES.has(term.name)) continue
				if (matches(term, prose)) {
					hits.push({ path, line: index + 1, name: term.name, text: line.trim() })
				}
			}
			return
		}

		const isShell = family === 'shell'
		const inComment = isShell
			? /^\s*#/.test(line)
			: /^\s*(\/\/|\/\*|\*)/.test(line) || line.includes('//')
		let code = stripStringLiterals(line)
		if (isShell && !inComment) code = code.replace(WORKSPACE_PACKAGE_PATH, 'providers/')

		// Two haystacks rather than one concatenated string. The English
		// collision guard asks WHERE a match sits in its sentence, and gluing
		// the stripped code to the raw line puts a sentence-initial name in the
		// middle of the result — so the position it would read is an artefact of
		// the concatenation. Matching each piece separately is also strictly
		// more correct: a joined string can match a multi-word name across the
		// seam, where neither piece contains it.
		const haystacks = inComment ? [code, line] : [code]

		for (const term of TERMS) {
			if (haystacks.some((haystack) => matches(term, haystack))) {
				hits.push({ path, line: index + 1, name: term.name, text: line.trim() })
			}
		}
	})

	return hits
}

// Before anything is scanned: the matcher has to agree with its own cases, or
// its verdict about the tree means nothing.
selfCheck()

const all = []

// The repository's own top-level pages are the most public prose there is,
// and they were the one surface no walk reached. Top level only, and
// deliberately not a recursive walk from the root: `.work/` is gitignored
// working memory where naming another system is the WORK — a comparative
// analysis has to say what it compared against.
//
// That exemption is a property of being UNTRACKED, not of the directory's
// name. When the documentation tree moved to `docs/`, nine of those documents
// were measured against this rule and produced 87 findings between them, so
// they stayed in `.work/` rather than moving with the rest.
//
// Whether they could instead move into `docs/` under a path exemption was put
// to the owner, who ruled that no third-party brand name appears in tracked
// prose. That ruling is settled, and it is the owner's to revisit — not a
// default, not a convention, and not something to reopen from inside this
// file. Adding a path exemption here would reverse an owner decision in the
// least visible place available. Do not; raise it instead.
//
// The installers sit at this level too, and they are the most exposed files in
// the repository: `install.sh` runs on a machine where namzu does not exist
// yet, for a person who has read nothing else. Any top-level shell or
// PowerShell script is taken, not just the two that exist today — naming them
// individually would mean the next one arrives unscanned, which is the shape of
// the gap this closes.
for (const entry of await readdir(ROOT, { withFileTypes: true })) {
	if (!entry.isFile() || !/\.(md|sh|ps1)$/.test(entry.name)) continue
	all.push(...findings(await readFile(join(ROOT, entry.name), 'utf-8'), entry.name))
}

// `tools/`, `.github/` and `.husky/` joined in issue #220. Each holds authored
// material the rule always covered and the scan never reached: a workflow's
// rationale comments, a gate script's docstring, a hook's explanation of what
// it refuses. `.claude/` is here for the same reason — its skill files are
// tracked prose that instructs an agent, which is as authored as it gets.
//
// Still deliberately absent: `.work/`. That exemption is a property of being
// UNTRACKED, not of a name on this list, and it is spelled out above.
for (const dir of ['packages', 'docs', 'scripts', 'tools', '.github', '.husky', '.claude']) {
	try {
		for await (const file of walk(join(ROOT, dir))) {
			const path = relative(ROOT, file).split(sep).join('/')
			// This file lists the forbidden names in order to forbid them.
			if (path.endsWith('audit-external-names.mjs')) continue
			all.push(...findings(await readFile(file, 'utf-8'), path))
		}
	} catch {
		// A directory that does not exist is not a failure.
	}
}

if (all.length === 0) {
	console.log('No third-party product name in a comment or identifier.')
	process.exit(0)
}

console.error(`${all.length} external-name reference(s):\n`)
for (const hit of all) {
	console.error(`  ${hit.path}:${hit.line}  [${hit.name}]`)
	console.error(`    ${hit.text.slice(0, 140)}`)
}
process.exit(1)
