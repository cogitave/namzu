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
 * **Respelling used to walk through, and mostly no longer does.** This matched
 * literal spellings, so every multi-token brand crushed into one entry was
 * evaded by writing it the way prose actually writes it — with a space, a
 * hyphen, or as an initialism. Measured: eleven of eleven variants passed.
 *
 * Closed by `words`, below: an entry now carries the brand written in its OWN
 * words, and the separator between those words is optional when matching, so
 * one entry covers `LangChain`, `lang chain` and `lang-chain` at once. The
 * sharpest case in the report was `huggingface`, where the spaced form is the
 * brand's own standard spelling and the entry was therefore spelled wrong for
 * matching; that is a data fix and it is separate from the matching fix.
 *
 * **What is deliberately still open**, because closing it costs more than it
 * buys: the all-lowercase separated form of `open ai`. `an open AI model` is
 * ordinary and correct English in this domain, and no casing rule separates it
 * from a lowercase mention of the company — so the separated form of that one
 * entry is matched only when every word of it is capitalised or ALL-CAPS
 * (`separatedFormIsEnglish`). `Open AI` and `OPEN AI` are caught; `open ai` is
 * not. A check that fires on correct prose is a check somebody switches off,
 * which is the same failure by a different road.
 *
 * The rejected alternative was normalising the HAYSTACK — deleting separators
 * before matching. It was built on the previous entry list and measured on the
 * same fixtures rather than argued about, because it splits into two designs
 * that fail differently:
 *
 *  - **Collapse, keep the `\b` anchors.** Closes 0 of 13 evasions and loses
 *    7 of 7 canonical spellings. Collapsing `we copied OpenAI code` yields
 *    `wecopiedOpenAIcode`, where there is no boundary left to anchor to, so the
 *    check does not weaken — it stops working. It fails 7 of this file's own
 *    discriminator cases.
 *  - **Collapse, drop the anchors.** Closes 11 of 13, and fires on 4 of 15
 *    ordinary-English controls: `an open airport`, `an open AI model`, `we auto
 *    generate the client`, `the crew aims to keep the roster small`. That is
 *    the trade the notes on `cursor`, `render` and `railway` already refuse,
 *    and it still loses the two multi-word entries.
 *
 * Worth stating precisely, because the obvious guess is wrong: dropping the
 * anchors does NOT resurrect `coherent` for `cohere` or `stranded` for
 * `strands`. Those two are `collidesWithEnglish`, and the Title-Case guard
 * catches them independently of the boundary. The false positives it does
 * produce are the ones listed above, which is why they are listed rather than
 * summarised.
 *
 * The approach here — the brand's own words, with an optional separator —
 * closes 13 of 13 with 0 of 15 controls firing and 0 canonical spellings lost.
 * Its cost is a maintenance surface the other option would not have had: a
 * brand added without `words` is quietly matched the old way. That is real, it
 * is why the note on `FORBIDDEN` is worded as an instruction, and it is not
 * something this file can check for itself.
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
 * green. The respelling fix does not change any of them: it decides what
 * counts as the name, not which text is read.
 *
 * ## Prose this repository writes that nothing here reads, measured 2026-08-11
 *
 * This walks the working tree. Four surfaces carry authored prose and are not
 * in it, and none is checked anywhere else either — established by looking
 * rather than assumed:
 *
 *  - **Commit messages.** There are no git hooks, no commitlint configuration
 *    in the repository and no commitlint step in `.github/workflows/ci.yml`.
 *    So a commit message is read by no gate at all, for this rule or any other.
 *  - **PR titles and bodies**, **issue text**, and **branch names**. The audit
 *    is invoked once, as `node scripts/audit-external-names.mjs` over a
 *    checkout; none of those three is in a checkout.
 *
 * Not closed here, and the reason is a design question rather than effort: the
 * text discussing this rule has to name the brands. The issue that produced
 * this change is a table of eleven of them, and a PR body explaining a fix to
 * the list cannot avoid them either. So the mechanism needs an exemption for
 * the conversation ABOUT the rule before it can be turned on at all, and that
 * is not a variation on this file — it is a hook plus a job that reads the
 * forge API. Recorded so the next reader inherits the measurement instead of
 * repeating it.
 */

import { execFileSync } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

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
	// `words` is how the brand is written in prose, and the separator between
	// those words is optional when matching — so one entry covers the joined
	// spelling, the spaced one and the hyphenated one. Every entry below whose
	// canonical form crushes two words together needs it; without it the entry
	// catches only the spelling nobody types.
	//
	// **When you add a brand here, write it in its own words.** That is the one
	// thing this list cannot check for you: an entry with no `words` is not an
	// error, it is today's behaviour, and today's behaviour is the defect this
	// field exists to fix.
	{ name: 'chatgpt', words: 'chat gpt' },
	{
		name: 'openai',
		words: 'open ai',
		// `an open AI model` is ordinary English here. See the header: the
		// separated form is caught only when every word of it reads as a name.
		separatedFormIsEnglish: true,
		// An initialism is a different string, not a respelling, so it cannot
		// be derived — it is data or it is missed.
		aliases: ['oai'],
	},
	{ name: 'langchain', words: 'lang chain' },
	{ name: 'langgraph', words: 'lang graph' },
	{ name: 'llamaindex', words: 'llama index' },
	{ name: 'autogen', words: 'auto gen' },
	{ name: 'crewai', words: 'crew ai' },
	// Issue #217. `strands` is a verb this codebase uses correctly about an
	// orphaned session, and the sentence that first tripped the rule was a
	// sentence ABOUT the rule tripping.
	{ name: 'strands', collidesWithEnglish: true },
	'vercel',
	// 'cursor' is deliberately absent: it collides with the pagination
	// cursor this codebase threads through every list call, and a rule that
	// cries wolf on a correct word gets switched off.
	//
	// `co pilot` also matches the aviation sense, hyphenated or spaced. That is
	// intended rather than tolerated: "namzu is your co-pilot" is positioning,
	// which is the sentence this whole rule exists to refuse, and the one-word
	// spelling was already matched in that sense before this change.
	{ name: 'copilot', words: 'co pilot' },
	'gemini',
	'mistral',
	// Found while fixing #217, by running the matcher rather than reading it:
	// "the plan should cohere with the roadmap" is flagged today. Shipping a fix
	// billed as general while leaving this would be fixing one instance of a
	// class and calling the class done.
	{ name: 'cohere', collidesWithEnglish: true },
	// The issue's sharpest finding, and a DATA defect rather than a matching
	// one: `Hugging Face` is the brand's own standard spelling, so the
	// one-word form this entry carried is the unusual one and the entry was
	// doing no work at all. It would still do none under any matcher.
	{ name: 'huggingface', words: 'hugging face' },
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
	{ name: 'github actions', aliases: ['gh actions'] },
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
 *
 * Each entry becomes one or more terms carrying `words` — the brand split into
 * the words prose writes it in — and every alias becomes a term of its own
 * under the SAME reported `name`. Keeping the name separate from the spelling
 * is what lets `DRIVEN_SERVICES`, the reporting line and the self-check tables
 * go on identifying an entry by `openai` while the matcher works from
 * `['open', 'ai']`; folding the two together would have made the prose
 * exemption for a driven service depend on how its brand is punctuated.
 */
const TERMS = FORBIDDEN.flatMap((entry) => {
	const e = typeof entry === 'string' ? { name: entry } : entry
	const base = {
		name: e.name,
		collidesWithEnglish: e.collidesWithEnglish ?? false,
		separatedFormIsEnglish: e.separatedFormIsEnglish ?? false,
	}
	return [
		{ ...base, words: (e.words ?? e.name).split(' ') },
		...(e.aliases ?? []).map((alias) => ({ ...base, words: alias.split(' ') })),
	]
})

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
	// The model price catalogue: a table keyed by model id, and the resolver
	// that reads it. Exactly the category the context-window table above is
	// exempt for — deleting the ids would delete the feature, since a rate card
	// that names no model prices nothing. The generated module carries its ids
	// as quoted keys and would pass on the literal rule alone; the exemption is
	// for the source comments that have to say which driver reports cache reads
	// inside its prompt count and which reports them alongside, because that
	// distinction IS the interoperability.
	'packages/sdk/src/pricing/',
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
 */
const AUDIT_ROOTS = ['packages/', 'docs/', 'scripts/', 'tools/', '.github/']
const INVENTORY_MAX_BYTES = 16 * 1024 * 1024

/**
 * This gate audits authored working-tree content: every tracked path plus each
 * untracked path Git says is eligible to be added. Ignore rules are the source
 * of truth for runtime state, build output and nested worktrees; hard-coding
 * their directory names here would hide a file that had been force-tracked.
 */
function inventoriedPaths() {
	const output = execFileSync(
		'git',
		['ls-files', '--cached', '--others', '--exclude-standard', '--deduplicate', '-z'],
		{
			cwd: ROOT,
			encoding: 'utf8',
			maxBuffer: INVENTORY_MAX_BYTES,
		},
	)
	return output.split('\0').filter(Boolean)
}

function shouldAuditPath(path) {
	if (!path.includes('/')) return /\.(md|sh|ps1)$/.test(path)
	if (!AUDIT_ROOTS.some((root) => path.startsWith(root))) return false
	return SCANNED.test(path)
}

const isErrno = (error, code) =>
	typeof error === 'object' && error !== null && 'code' in error && error.code === code

/**
 * A cached path may be deleted in the working tree, in which case there is no
 * prose left to inspect. ENOENT from a path that still exists — notably a
 * broken file symlink — is structural failure, not permission to skip it.
 */
async function readInventoriedFile(path) {
	const full = join(ROOT, path)
	try {
		return await readFile(full, 'utf8')
	} catch (error) {
		if (!isErrno(error, 'ENOENT')) throw error
		try {
			await lstat(full)
		} catch (statError) {
			if (isErrno(statError, 'ENOENT')) return undefined
			throw statError
		}
		throw error
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
const WIRE_VALUE_DOCS = ['packages/providers/']

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
	return titleWords(name.split(' ')).join(' ')
}

/** The same transform the matcher uses, on the split form it actually holds. */
const titleWords = (words) => words.map((w) => w.charAt(0).toUpperCase() + w.slice(1))

/**
 * What may sit between the words of a brand and still be the brand.
 *
 * Zero of them is the joined spelling a list like this always carried;
 * one or more is how prose writes the same name. Making the separator
 * OPTIONAL rather than required is what lets one entry cover `LangChain`,
 * `lang chain` and `lang-chain` without three entries drifting apart.
 */
const SEPARATOR = '[-\\s]'

/**
 * Whether a separated match reads as a NAME rather than as two ordinary words.
 *
 * Only consulted for `separatedFormIsEnglish` entries, and only on a match that
 * actually contains a separator. Every word has to be capitalised or ALL-CAPS:
 * `Open AI` and `OPEN AI` qualify, `open AI` does not — which is the whole
 * point, because `an open AI model` is a sentence this repository could
 * legitimately write.
 *
 * No sentence-position test, unlike `collidesWithEnglish`. That guard exists
 * because a capital at the start of a sentence is not evidence of a proper
 * noun; here the SECOND word carrying a capital is evidence no sentence
 * position explains, so the position never has to be asked about.
 */
function readsAsAName(text) {
	return text
		.split(/[-\s]+/)
		.every((word) => /^[A-Z]/.test(word) || (word === word.toUpperCase() && /[A-Z]/.test(word)))
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
	// Joined and separated are built as two patterns rather than one with an
	// optional separator, because the entry's verdict differs between them:
	// a brand written as one word is never ordinary English, and the same
	// brand written as two words sometimes is. One pattern could match both
	// and could not tell them apart afterwards.
	const joined = term.words.join('')
	const separated = term.words.join(`${SEPARATOR}+`)
	const titledJoined = titleWords(term.words).join('')
	const titledSeparated = titleWords(term.words).join(`${SEPARATOR}+`)

	if (term.collidesWithEnglish) {
		// ALL-CAPS is never the ordinary English sense in running prose, so it
		// needs no position test.
		if (new RegExp(`\\b${separated.toUpperCase()}\\b`).test(haystack)) return true
		const standalone = new RegExp(`\\b${titledSeparated}\\b`, 'g')
		for (let hit = standalone.exec(haystack); hit; hit = standalone.exec(haystack)) {
			if (!startsASentence(haystack, hit.index)) return true
		}
	} else {
		// The joined spelling, unconditionally — `OpenAI`, `openai`,
		// `LangChain`. This is the branch that existed before, and nothing
		// about it changes.
		if (new RegExp(`\\b${joined}\\b`, 'i').test(haystack)) return true

		// The separated spellings, which are the eleven that used to walk
		// through. Guarded only where the words are also an English phrase.
		if (term.words.length > 1) {
			const spaced = new RegExp(`\\b${separated}\\b`, 'gi')
			for (let hit = spaced.exec(haystack); hit; hit = spaced.exec(haystack)) {
				if (!term.separatedFormIsEnglish || readsAsAName(hit[0])) return true
			}
		}
	}

	// Case-SENSITIVE, deliberately. A camelCase boundary is defined by the
	// change of case, so an `i` flag turns `[A-Z]` into `[A-Za-z]` and the
	// rule starts matching any word that merely begins with the name —
	// `coherent` for `cohere`, `stranded` for `strands`. That false
	// positive is exactly how a rule like this gets switched off.
	//
	// The third spelling is the brand's own words in lowerCamel — `langChain`,
	// `openAi` — which the two below cannot reach: they look for the name run
	// together in one case, and an identifier that capitalises the SECOND word
	// is neither. `langChainAdapter` used to pass, and a borrowed name inside
	// an identifier is the case this branch exists for.
	const camelJoined = [term.words[0], ...titleWords(term.words.slice(1))].join('')
	return (
		new RegExp(`\\b${joined}(?=[A-Z0-9_-])`).test(haystack) ||
		new RegExp(`\\b${titledJoined}(?=[A-Z0-9_-])`).test(haystack) ||
		(term.words.length > 1 && new RegExp(`\\b${camelJoined}(?=[A-Z0-9_-])`).test(haystack))
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

	// ---- issue #255: the eleven respellings that used to walk through ----
	//
	// Every one of these was measured passing against the previous matcher, so
	// each line here is a case that went from green to red on purpose. They are
	// in this table rather than in a separate fixture because `scripts/` has no
	// test runner: this table IS the test, and it runs before every scan.
	['we took the streaming shape from Open AI', 'openai', true],
	['we took the streaming shape from OAI', 'openai', true],
	['the Co-Pilot seat model is not ours', 'copilot', true],
	['their Hugging Face integration does this differently', 'huggingface', true],
	['this mirrors how lang chain sequences its steps', 'langchain', true],
	['this mirrors how lang graph sequences its steps', 'langgraph', true],
	['their llama index retriever ranks differently', 'llamaindex', true],
	['the crew ai roster model is not ours', 'crewai', true],
	['the chat gpt product is not what this drives', 'chatgpt', true],
	['the auto gen conversation loop works another way', 'autogen', true],
	['the GH Actions runner does this for us', 'github actions', true],

	// The hyphen, separately from the space: they are one optional separator in
	// the pattern, and a change that dropped either would still pass the other.
	['this mirrors how lang-chain sequences its steps', 'langchain', true],
	['their hugging-face integration does this differently', 'huggingface', true],

	// An identifier that capitalises the brand's second word.
	['const langChainAdapter = null', 'langchain', true],

	// ---- the false-positive controls, which are the other half ----
	//
	// A matcher that fires on these is worse than the one it replaces: the
	// notes on `cursor`, `render` and `railway` refuse exactly this trade, and
	// a check that cries wolf is a check somebody switches off.
	['an open airport has nothing to do with this', 'openai', false],
	['an open standard for tool calls', 'openai', false],
	['we auto generate the client from the schema', 'autogen', false],
	['a language chain of prompts is not a design', 'langchain', false],
	['the index of llama weights is not a product name', 'llamaindex', false],
	['a crew of agents shares one budget', 'crewai', false],
	['hugging the cache line keeps the loop hot', 'huggingface', false],
	['a chat surface renders the transcript', 'chatgpt', false],
	['the graph language of the plan is our own', 'langgraph', false],

	// The one respelling left open, recorded as a case so it is a DECISION with
	// a line to point at rather than an oversight. `an open AI model` is
	// ordinary English here and no casing rule separates it from a lowercase
	// mention of the company, so the separated form is caught only when it
	// reads as a name. The capitalised spellings above are the ones a person
	// actually writes.
	['an open AI model runs on the operator machine', 'openai', false],
	['we took the streaming shape from open ai', 'openai', false],
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
		// Every term reported under this name, not the first one: an alias is a
		// term of its own sharing the name, so `find` would test the canonical
		// spelling and silently never test the alias.
		const terms = TERMS.filter((t) => t.name === name)
		if (terms.length === 0) {
			broken.push(`no forbidden entry named ${name}`)
			continue
		}
		const actual = terms.some((term) => matches(term, text))
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

let inventory
try {
	inventory = inventoriedPaths()
} catch (error) {
	console.error(`the authored-file inventory could not be read: ${String(error)}`)
	process.exit(2)
}

for (const path of inventory) {
	if (!shouldAuditPath(path)) continue
	// This file lists the forbidden names in order to forbid them.
	if (path.endsWith('audit-external-names.mjs')) continue
	let source
	try {
		source = await readInventoriedFile(path)
	} catch (error) {
		console.error(`the authored file ${path} could not be read: ${String(error)}`)
		process.exit(2)
	}
	if (source === undefined) continue
	all.push(...findings(source, path))
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
