import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const audit = join(here, '..', 'audit-external-names.mjs')
const roots: string[] = []
const forbiddenProse = '# We copied Gemini to shape this interface.\n'

function caseVariantsAreDistinct(): boolean {
	const root = mkdtempSync(join(tmpdir(), 'namzu-name-case-'))
	try {
		mkdirSync(join(root, '.namzu'))
		return !existsSync(join(root, '.NAMZU'))
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

const CASE_VARIANTS_ARE_DISTINCT = caseVariantsAreDistinct()

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function repository(): string {
	const root = mkdtempSync(join(tmpdir(), 'namzu-name-inventory-'))
	roots.push(root)
	execFileSync('git', ['init', '-q'], { cwd: root })
	mkdirSync(join(root, 'packages/sdk/src'), { recursive: true })
	writeFileSync(join(root, '.gitignore'), '.namzu/\ndist/\n', 'utf8')
	writeFileSync(join(root, 'packages/sdk/src/clean.ts'), 'export const localValue = 1\n', 'utf8')
	execFileSync('git', ['add', '.gitignore', 'packages/sdk/src/clean.ts'], { cwd: root })
	return root
}

/** What a case never inherits from the process running the tests: in CI, that holds the real list. */
const INHERITED = [
	'NAMZU_DOWNSTREAM_NAMES',
	'GITHUB_ACTIONS',
	'GITHUB_EVENT_NAME',
	'GITHUB_EVENT_PATH',
]

/** A placeholder no tree here carries, so the downstream-name rule runs and finds nothing. */
const UNUSED = 'zyxwvut'

/**
 * Runs the audit in `root`. `names` is the downstream list for this run, one
 * entry per line as the secret carries it — placeholders only, so that this
 * file names no one; `[]` leaves `NAMZU_DOWNSTREAM_NAMES` unset. `env` sets a
 * variable, or with `undefined` removes one; `args` follow the script.
 */
function runAudit(
	root: string,
	names: string[] = [UNUSED],
	env: Record<string, string | undefined> = {},
	args: string[] = [],
) {
	const base: Record<string, string | undefined> = { ...process.env }
	for (const key of INHERITED) delete base[key]
	if (names.length > 0) base.NAMZU_DOWNSTREAM_NAMES = names.join('\n')
	Object.assign(base, env)
	for (const [key, value] of Object.entries(base)) if (value === undefined) delete base[key]
	return spawnSync(process.execPath, [audit, ...args], {
		cwd: root,
		encoding: 'utf8',
		env: base as NodeJS.ProcessEnv,
	})
}

/** An event file as the CI runner writes one, outside the tree under audit. */
function eventFile(payload: unknown): string {
	const directory = mkdtempSync(join(tmpdir(), 'namzu-name-event-'))
	roots.push(directory)
	const path = join(directory, 'event.json')
	writeFileSync(path, JSON.stringify(payload), 'utf8')
	return path
}

/** The variables the CI runner sets for a run triggered by `event`. */
function inActions(event: string, payload: unknown): Record<string, string> {
	return { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventFile(payload) }
}

/** A pull request into `example/project` from the repository `head`. */
const pullRequestFrom = (head: string | null) => ({
	pull_request: {
		number: 7,
		head: { ref: 'fix/tidy', repo: head === null ? null : { full_name: head } },
		base: { ref: 'main', repo: { full_name: 'example/project' } },
	},
})

function write(root: string, path: string, text: string) {
	mkdirSync(dirname(join(root, path)), { recursive: true })
	writeFileSync(join(root, path), text, 'utf8')
}

test('ignored runtime state is outside the authored-file inventory', () => {
	const root = repository()
	const runtime = join(root, 'packages/sdk/.namzu')
	mkdirSync(runtime, { recursive: true })
	writeFileSync(join(runtime, 'runtime.md'), forbiddenProse, 'utf8')

	const result = runAudit(root)
	assert.equal(result.status, 0, result.stderr)
	assert.match(result.stdout, /No third-party product name/)
})

for (const directory of ['.namzu-cache', '.NAMZU']) {
	test(
		`a similarly named ${directory} directory remains auditable`,
		{
			skip:
				directory === '.NAMZU' && !CASE_VARIANTS_ARE_DISTINCT
					? 'the filesystem resolves .NAMZU to the ignored .namzu directory'
					: false,
		},
		() => {
			const root = repository()
			const path = join(root, 'packages/sdk', directory)
			mkdirSync(path, { recursive: true })
			writeFileSync(join(path, 'authored.md'), forbiddenProse, 'utf8')

			const result = runAudit(root)
			assert.equal(result.status, 1, result.stderr)
			assert.match(
				result.stderr,
				new RegExp(`packages/sdk/${directory.replace('.', '\\.')}\\/authored\\.md`),
			)
		},
	)
}

test('force-tracked prose remains auditable below an ignored directory', () => {
	const root = repository()
	const runtime = join(root, 'packages/sdk/.namzu')
	mkdirSync(runtime, { recursive: true })
	writeFileSync(join(runtime, 'tracked.md'), forbiddenProse, 'utf8')
	execFileSync('git', ['add', '-f', 'packages/sdk/.namzu/tracked.md'], { cwd: root })

	const result = runAudit(root)
	assert.equal(result.status, 1, result.stderr)
	assert.match(result.stderr, /packages\/sdk\/\.namzu\/tracked\.md/)
})

test('untracked source that is eligible to add is audited', () => {
	const root = repository()
	writeFileSync(join(root, 'packages/sdk/src/new.md'), forbiddenProse, 'utf8')

	const result = runAudit(root)
	assert.equal(result.status, 1, result.stderr)
	assert.match(result.stderr, /packages\/sdk\/src\/new\.md/)
})

test('an inventoried broken file link is a structural failure', () => {
	const root = repository()
	symlinkSync('missing.md', join(root, 'packages/sdk/src/broken.md'))

	const result = runAudit(root)
	assert.equal(result.status, 2, result.stderr)
	assert.match(result.stderr, /authored file packages\/sdk\/src\/broken\.md could not be read/)
})

test('failure to obtain the Git inventory is structural', () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-name-no-inventory-'))
	roots.push(root)

	const result = runAudit(root)
	assert.equal(result.status, 2, result.stderr)
	assert.match(result.stderr, /authored-file inventory could not be read/)
})

test('a cached file deleted from the working tree has no prose left to audit', () => {
	const root = repository()
	rmSync(join(root, 'packages/sdk/src/clean.ts'))

	const result = runAudit(root)
	assert.equal(result.status, 0, result.stderr)
})

test('a scoped source attribution exception does not exempt other prose or kernel identifiers', () => {
	const root = repository()
	const docs = join(root, 'docs/sdk')
	mkdirSync(docs, { recursive: true })
	writeFileSync(join(docs, 'cognitive-storage.md'), 'Source comparison against Pydantic AI.\n')
	assert.equal(runAudit(root).status, 0)
	writeFileSync(join(docs, 'cognitive-storage.md'), forbiddenProse)
	assert.equal(runAudit(root).status, 1)
	writeFileSync(join(docs, 'cognitive-storage.md'), 'Source comparison against Pydantic AI.\n')
	writeFileSync(join(docs, 'unrelated.md'), 'Borrow Pydantic naming.\n')
	assert.equal(runAudit(root).status, 1)
	rmSync(join(docs, 'unrelated.md'))
	writeFileSync(join(root, 'packages/sdk/src/clean.ts'), 'export const pydanticKernel = 1\n')
	assert.equal(runAudit(root).status, 1)
})

test('commissioned research may attribute its source without exempting other prose', () => {
	const root = repository()
	mkdirSync(join(root, 'docs/sdk'), { recursive: true })
	writeFileSync(join(root, 'docs/sdk/memory-research.md'), 'Pydantic search was inspected.\n')
	assert.equal(runAudit(root).status, 0)
	writeFileSync(join(root, 'docs/sdk/unrelated.md'), 'Pydantic shapes our kernel.\n')
	const result = runAudit(root)
	assert.equal(result.status, 1)
	assert.match(result.stderr, /docs\/sdk\/unrelated.md/)
})

test('an exact release-history attribution does not exempt adjacent log prose', () => {
	const root = repository()
	mkdirSync(join(root, 'docs'), { recursive: true })
	const attribution =
		"- **Update** Scoped the Anthropic provider's optional Claude Code version probe out of framework filesystem tracing so server bundles do not absorb the consumer's complete project tree.\n"
	writeFileSync(join(root, 'docs/log.md'), attribution)
	assert.equal(runAudit(root).status, 0)
	writeFileSync(join(root, 'docs/log.md'), `${attribution}- **Update** Claude shapes this project.\n`)
	const result = runAudit(root)
	assert.equal(result.status, 1)
	assert.match(result.stderr, /docs\/log\.md/)
})

test('provider selection fixtures may name wire keys without exempting adjacent code', () => {
	const root = repository()
	mkdirSync(join(root, 'packages/cli/src/tui'), { recursive: true })
	const fixture = 'const selected = PROVIDER_REGISTRY.anthropic\n'
	writeFileSync(join(root, 'packages/cli/src/tui/model-switch.test.ts'), fixture)
	assert.equal(runAudit(root).status, 0)
	writeFileSync(join(root, 'packages/cli/src/tui/unrelated.ts'), fixture)
	const result = runAudit(root)
	assert.equal(result.status, 1)
	assert.match(result.stderr, /packages\/cli\/src\/tui\/unrelated.ts/)
})

test('device provider attribution stays scoped to integration docs and exact credential accesses', () => {
	const root = repository()
	mkdirSync(join(root, 'docs/cli'), { recursive: true })
	mkdirSync(join(root, 'packages/cli/src/tui'), { recursive: true })
	writeFileSync(join(root, 'docs/cli/google.md'), '# Gemini CLI credential reuse\n')
	writeFileSync(join(root, 'docs/cli/credentials.md'), '# Existing Claude sessions\n')
	writeFileSync(join(root, 'packages/cli/src/tui/agent.ts'), 'const token = det?.gemini\n')
	assert.equal(runAudit(root).status, 0)
	writeFileSync(join(root, 'docs/cli/unrelated.md'), '# We copied Claude here\n')
	const unrelated = runAudit(root)
	assert.equal(unrelated.status, 1)
	assert.match(unrelated.stderr, /docs\/cli\/unrelated.md/)
	writeFileSync(join(root, 'docs/cli/unrelated.md'), '# Unrelated documentation\n')
	writeFileSync(join(root, 'packages/cli/src/tui/agent.ts'), '/' + '/ We copied Gemini here\nconst gemini = 1\n')
	const result = runAudit(root)
	assert.equal(result.status, 1)
	assert.match(result.stderr, /packages\/cli\/src\/tui\/agent.ts/)
})

test('a downstream name is refused in literals, changelogs, changesets, backends and extension-less files', () => {
	const root = repository()
	// Each of these is a place the product-name rule above deliberately does
	// not read, and each is where a consumer's name actually sat (#530).
	const planted = {
		'packages/sandbox/src/backends/firecracker/index.ts':
			"throw new Error('(the host layer must supply ACME_SANDBOX_FC_TLS_CA in network mode)')\n",
		'packages/sdk/CHANGELOG.md': '- Example: `hostPath: "/var/lib/acme/sessions/<task>/outputs"`\n',
		'.changeset/quiet-hosts.md':
			'---\n"@namzu/sdk": patch\n---\n\nFixes a crash the Acme-side lifecycle hit.\n',
		'packages/sandbox/worker/Dockerfile': '# The acme image build surfaced it first.\n',
		'packages/sdk/coverage-config.json': '{ "owner": "acme" }\n',
	}
	for (const [path, text] of Object.entries(planted)) write(root, path, text)

	const refused = runAudit(root, ['acme'])
	assert.equal(refused.status, 1, refused.stderr)
	for (const path of Object.keys(planted)) {
		assert.match(
			refused.stderr,
			new RegExp(`${path.replaceAll('.', '\\.')}:\\d+  \\[downstream name\\]`),
		)
	}

	// The same tree against a list that names someone else: nothing above is a
	// product name, so both rules pass and the rule is proved to have run.
	const clean = runAudit(root, [UNUSED])
	assert.equal(clean.status, 0, clean.stderr)
	assert.match(clean.stdout, /No downstream consumer name anywhere in the tree/)
})

test('the list is read from NAMZU_DOWNSTREAM_NAMES, one name per line or separated by commas', () => {
	const root = repository()
	write(root, 'packages/sdk/src/a.ts', "export const first = 'acmecorp'\n")
	write(root, 'packages/sdk/src/b.ts', "export const second = 'zebraWidget'\n")

	for (const value of [
		'acmecorp\nzebra-widget\n',
		' acmecorp , zebra-widget ',
		'acmecorp\r\n\r\nzebra-widget',
	]) {
		const result = runAudit(root, [], { NAMZU_DOWNSTREAM_NAMES: value })
		assert.equal(result.status, 1, result.stderr)
		assert.match(result.stderr, /packages\/sdk\/src\/a\.ts:1 {2}\[downstream name\]/)
		assert.match(result.stderr, /packages\/sdk\/src\/b\.ts:1 {2}\[downstream name\]/)
		assert.doesNotMatch(result.stdout + result.stderr, /acmecorp|zebra|widget/i)
	}
})

test('without NAMZU_DOWNSTREAM_NAMES a local run fails; --without-downstream-names runs the rest and says so', () => {
	const root = repository()
	write(root, 'packages/sdk/src/host.ts', "export const host = 'acmecorp'\n")

	for (const value of [undefined, '', ' \n , \n']) {
		const unset = runAudit(root, [], { NAMZU_DOWNSTREAM_NAMES: value })
		assert.equal(unset.status, 2, unset.stderr)
		assert.match(unset.stderr, /^NAMZU_DOWNSTREAM_NAMES is not set\. /)
		assert.match(unset.stderr, /pass --without-downstream-names to run everything else/)
		assert.equal(unset.stdout, '')
	}

	const optedOut = runAudit(root, [], {}, ['--without-downstream-names'])
	assert.equal(optedOut.status, 0, optedOut.stderr)
	assert.match(
		optedOut.stdout,
		/^Downstream-name rule not run: NAMZU_DOWNSTREAM_NAMES is not set and --without-downstream-names was given\. CI runs it with the list\.\nNo third-party product name in a comment or identifier\.\n$/,
	)

	// The product-name rule still runs under the flag.
	writeFileSync(join(root, 'packages/sdk/src/new.md'), forbiddenProse, 'utf8')
	const product = runAudit(root, [], {}, ['--without-downstream-names'])
	assert.equal(product.status, 1, product.stderr)
	assert.match(product.stderr, /packages\/sdk\/src\/new\.md/)
	rmSync(join(root, 'packages/sdk/src/new.md'))

	// With the list, the flag changes nothing: a placeholder insertion is found.
	const listed = runAudit(root, ['acmecorp'], {}, ['--without-downstream-names'])
	assert.equal(listed.status, 1, listed.stderr)
	assert.match(
		listed.stderr,
		/\n {2}packages\/sdk\/src\/host\.ts:1 {2}\[downstream name\]\n {4}export const host = '\*\*\*'\n/,
	)
})

test('in GitHub Actions, a pull request from a fork skips the rule with a notice, and every other run without the list fails', () => {
	const root = repository()
	write(root, 'packages/sdk/src/host.ts', "export const host = 'acmecorp'\n")

	for (const head of ['contributor/project', null]) {
		// `null`: a fork deleted since its pull request opened has no repository.
		const fork = runAudit(root, [], inActions('pull_request', pullRequestFrom(head)))
		assert.equal(fork.status, 0, fork.stderr)
		assert.match(
			fork.stdout,
			/^::notice title=Downstream names skipped::NAMZU_DOWNSTREAM_NAMES is not set: this run is for a pull request from a fork, and GitHub gives such a run no secrets, so the downstream-name rule did not run here\./,
		)
		assert.match(fork.stdout, /\nNo third-party product name in a comment or identifier\.\n$/)
	}

	const others: [string, unknown][] = [
		['pull_request', pullRequestFrom('example/project')],
		['merge_group', { merge_group: { base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40) } }],
		['push', { ref: 'refs/heads/main' }],
		['workflow_dispatch', {}],
	]
	for (const [event, payload] of others) {
		const result = runAudit(root, [], inActions(event, payload))
		assert.equal(result.status, 2, `${event}: ${result.stdout}${result.stderr}`)
		assert.match(
			result.stderr,
			/^NAMZU_DOWNSTREAM_NAMES is not set\. This run did not receive the repository secret of that name/,
		)
		assert.match(result.stderr, /gh secret set NAMZU_DOWNSTREAM_NAMES/)
	}

	// An event file that cannot be read is no evidence of a fork.
	const unreadable = runAudit(root, [], {
		GITHUB_ACTIONS: 'true',
		GITHUB_EVENT_NAME: 'pull_request',
		GITHUB_EVENT_PATH: join(root, 'missing-event.json'),
	})
	assert.equal(unreadable.status, 2, unreadable.stderr)

	// A fork's pull request that does get the secret — a private repository can
	// send secrets to forks — is checked like any other.
	const withList = runAudit(
		root,
		['acmecorp'],
		inActions('pull_request', pullRequestFrom('contributor/project')),
	)
	assert.equal(withList.status, 1, withList.stderr)
	assert.match(withList.stderr, /packages\/sdk\/src\/host\.ts:1 {2}\[downstream name\]/)

	// No workflow can switch the rule off with the local opt-out.
	for (const names of [[], ['acmecorp']]) {
		const flagged = runAudit(root, names, inActions('push', { ref: 'refs/heads/main' }), [
			'--without-downstream-names',
		])
		assert.equal(flagged.status, 2, flagged.stderr)
		assert.match(
			flagged.stderr,
			/^--without-downstream-names is for a local checkout without access to the list\./,
		)
	}
})

test('an entry the list cannot use is refused by its position, never echoed', () => {
	const root = repository()
	const cases: [string, RegExp][] = [
		[
			'acmecorp\nab',
			/^the downstream-name list could not be read: entry 2 of NAMZU_DOWNSTREAM_NAMES cannot be used: it is shorter than 4 characters once folded/,
		],
		[
			'acmecorp, zebra widget=exact',
			/entry 2 of NAMZU_DOWNSTREAM_NAMES cannot be used: an `=exact` entry is one word/,
		],
		[
			'zebra-widget=fuzzy',
			/entry 1 of NAMZU_DOWNSTREAM_NAMES cannot be used: the only option an entry takes is `=exact`/,
		],
		['acmecorp=exact=exact', /entry 1 of NAMZU_DOWNSTREAM_NAMES cannot be used: the only option/],
		[
			'zeta eta theta iota kappa',
			/entry 1 of NAMZU_DOWNSTREAM_NAMES cannot be used: it has 5 parts/,
		],
		[
			'acmecorp\n----',
			/entry 2 of NAMZU_DOWNSTREAM_NAMES cannot be used: it has no letters or digits/,
		],
		['zyx=exact', /entry 1 of NAMZU_DOWNSTREAM_NAMES cannot be used: it is shorter than 4/],
	]
	for (const [value, expected] of cases) {
		const result = runAudit(root, [], { NAMZU_DOWNSTREAM_NAMES: value })
		assert.equal(result.status, 2, result.stderr)
		assert.match(result.stderr, expected)
		assert.doesNotMatch(result.stdout + result.stderr, /acmecorp|zebra|widget|fuzzy|kappa|zyx/i)
	}
})

test('an =exact entry matches a whole word in any case, and nothing inside an identifier or a longer word', () => {
	const root = repository()
	const whole = [
		'// the zorblax is calm',
		"export const hostPath = '/var/lib/zorblax/sessions'",
		'// the ZORBLAX-side lifecycle',
		'// the Ｚｏｒｂｌａｘ console',
	]
	const inside = [
		'export const zorblaxHost = 1',
		'export const ZORBLAX_TLS_CA = 1',
		'export const zorblax_id = 1',
		'// two zorblaxes',
		'// the zor-blax app',
	]
	write(root, 'packages/sdk/src/exact.ts', `${[...whole, ...inside].join('\n')}\n`)
	const line = (index: number) =>
		new RegExp(`packages/sdk/src/exact\\.ts:${index + 1} {2}\\[downstream name\\]`)

	const exact = runAudit(root, ['zorblax=exact'])
	assert.equal(exact.status, 1, exact.stderr)
	whole.forEach((_, index) => assert.match(exact.stderr, line(index)))
	inside.forEach((_, index) => assert.doesNotMatch(exact.stderr, line(whole.length + index)))
	assert.equal(exact.stderr.match(/\[downstream name\]/g)?.length, whole.length)
	assert.match(exact.stderr, /\n {4}\/\/ the \*\*\* is calm\n/)
	assert.doesNotMatch(exact.stdout + exact.stderr, /zorblax|ｚｏｒｂｌａｘ/i)

	// The same name as a default entry is found inside identifiers too, and
	// across a dash; a longer word is still another word.
	const fuzzy = runAudit(root, ['zorblax'])
	assert.equal(fuzzy.status, 1, fuzzy.stderr)
	assert.equal(fuzzy.stderr.match(/\[downstream name\]/g)?.length, whole.length + 4)
	assert.doesNotMatch(fuzzy.stderr, line(whole.length + 3))
})

/**
 * The kept release note, read from the real changelog, and the old member
 * value it quotes. That value is a listed name, which this file never spells:
 * it is read here at run time and only ever passed to the audit as part of its
 * list, so that anything the audit prints redacts it.
 */
function keptReleaseNote(): { kept: string; member: string } {
	const changelog = readFileSync(join(here, '..', '..', 'packages/sdk/CHANGELOG.md'), 'utf8')
	const kept = changelog
		.split('\n')
		.find((line) => /^\s*- `ToolCatalogSurface`: the `'[a-z]+'` member is now/.test(line))
	assert.ok(
		kept,
		'the kept ToolCatalogSurface release note is no longer in packages/sdk/CHANGELOG.md',
	)
	const member = /the `'([a-z]+)'` member is now/.exec(kept)?.[1]
	assert.ok(member)
	return { kept, member }
}

test('a kept release-history line is exempt only as that exact line', () => {
	// `ToolCatalogSurface`, which the kept line carries, stands in for a listed name.
	const { kept, member } = keptReleaseNote()
	const names = ['ToolCatalogSurface', member]
	const root = repository()
	write(root, 'packages/sdk/CHANGELOG.md', `${kept}\n`)
	assert.equal(runAudit(root, names).status, 0)

	write(root, 'packages/sdk/CHANGELOG.md', `${kept}\n- Built for the host.\n${kept} Also.\n`)
	const result = runAudit(root, names)
	assert.equal(result.status, 1)
	assert.doesNotMatch(result.stderr, /CHANGELOG\.md:1 /)
	assert.doesNotMatch(result.stderr, /CHANGELOG\.md:2 /)
	assert.match(
		result.stderr,
		/CHANGELOG\.md:3 {2}\[downstream name\]\n {4}- `\*\*\*`: the `'\*\*\*'` member/,
	)
})

test('every spelling of a listed name is one entry, and a longer word is another word', () => {
	const root = repository()
	const spellings = [
		'const examplecorp = 1',
		'const EXAMPLECORP_TLS_CA = 1',
		'const exampleCorpHost = 1',
		'// ExampleCorp built this',
		'// the example-corp side',
		'// the EXAMPLE.CORP side',
		'// the example corp side',
		'// the example_corp side',
		'// the ｅｘａｍｐｌｅｃｏｒｐ side',
		'// the éxamplecorp side',
		'// the example­corp side',
		"hostPath: '/var/lib/examplecorp/sessions'",
	]
	write(root, 'packages/sdk/src/names.ts', `${spellings.join('\n')}\n`)
	// Entered with its parts as written: the same entry as `examplecorp`.
	const result = runAudit(root, ['Example Corp'])
	assert.equal(result.status, 1, result.stderr)
	spellings.forEach((_, index) => {
		assert.match(result.stderr, new RegExp(`packages/sdk/src/names\\.ts:${index + 1} {2}\\[`))
	})

	write(
		root,
		'packages/sdk/src/names.ts',
		[
			'// examplecorps, examplecorporate and anexamplecorp are other words',
			'// so is example/corp, and a line break between',
			'// example',
			'// corp',
		].join('\n'),
	)
	const other = runAudit(root, ['examplecorp'])
	assert.equal(other.status, 0, other.stderr)
})

test('folding does not depend on the machine locale', () => {
	// A Turkish locale lowercases a capital I differently. The matcher uses the
	// locale-independent mapping and removes the dot a dotted capital carries,
	// so the verdict is the same under every locale; a dotless i is another
	// letter under every locale.
	const root = repository()
	write(root, 'packages/sdk/src/tr.ts', '// MİNİCORP and MINICORP\n// mınıcorp\n')
	for (const locale of ['tr_TR.UTF-8', 'C', 'en_US.UTF-8']) {
		const result = runAudit(root, ['minicorp'], { LANG: locale, LC_ALL: locale })
		assert.equal(result.status, 1, `${locale}: ${result.stderr}`)
		assert.match(
			result.stderr,
			/packages\/sdk\/src\/tr\.ts:1 {2}\[downstream name\]\n {4}\/\/ \*\*\* and \*\*\*\n/,
		)
		assert.doesNotMatch(result.stderr, /tr\.ts:2 /, locale)
	}
})

test('a refusal never prints the name it refused, in a line or in a path', () => {
	// Not `acme`: the refusal's own advice suggests that placeholder by name.
	const root = repository()
	write(
		root,
		'packages/sdk/src/host.ts',
		"export const endpoint = 'https://examplecorp.example/api'\n",
	)
	write(root, 'docs/examplecorp-deploy.md', '# Deploying\n')

	const result = runAudit(root, ['examplecorp'])
	assert.equal(result.status, 1, result.stderr)
	assert.doesNotMatch(result.stderr, /examplecorp/i)
	assert.doesNotMatch(result.stdout, /examplecorp/i)
	assert.match(result.stderr, /packages\/sdk\/src\/host\.ts:1 {2}\[downstream name\]/)
	assert.match(result.stderr, /https:\/\/\*\*\*\.example\/api/)
	assert.match(result.stderr, /docs\/\*\*\*-deploy\.md {2}\[downstream name\]/)
})

test('what the product-name rule reports is redacted too, when both rules hit one line or path', () => {
	// The product-name rule quotes the line and the path it flagged. Beside a
	// consumer's name, that quotation would publish the name in the public log
	// while the downstream report above it printed `***`.
	//
	// The product name below sits only in string literals, and no line of this
	// test holds two adjacent slashes, so the audit run over this repository
	// reads none of it as prose.
	const slashes = '/'.repeat(2)
	const root = repository()
	write(
		root,
		'packages/sdk/src/a.ts',
		`${slashes} The Examplecorp host deploys this through GitHub Actions.\n`,
	)
	write(root, 'docs/examplecorp-deploy.md', '# Deploying\n\nRuns on GitHub Actions.\n')
	// A report cuts a line at 140 characters. Cut before redacting, a name
	// straddling the cut would be printed in part.
	const straddle = `${slashes} GitHub Actions ${'x'.repeat(116)} examplecorp tail\n`
	assert.equal(straddle.indexOf('examplecorp'), 135)
	write(root, 'packages/sdk/src/long.ts', straddle)

	const result = runAudit(root, ['examplecorp'])
	assert.equal(result.status, 1, result.stderr)
	const reported = (...lines: string[]) => result.stderr.includes(`\n${lines.join('\n')}\n`)
	assert.ok(
		reported(
			'  packages/sdk/src/a.ts:1  [github actions]',
			`    ${slashes} The *** host deploys this through GitHub Actions.`,
		),
		result.stderr,
	)
	assert.ok(reported('  docs/***-deploy.md:3  [github actions]'), result.stderr)
	assert.ok(
		reported(
			'  packages/sdk/src/long.ts:1  [github actions]',
			`    ${slashes} GitHub Actions ${'x'.repeat(116)} *** t`,
		),
		result.stderr,
	)
	assert.doesNotMatch(result.stderr, /examp/i)
	assert.doesNotMatch(result.stdout, /examp/i)
})

test("a line that would show any entry's text is withheld, even where the matcher counts no name", () => {
	// `examplecorps` and `zorblaxHost` are other words to the matcher, so
	// nothing redacts them; printed, they would still spell an entry.
	const slashes = '/'.repeat(2)
	const root = repository()
	write(
		root,
		'packages/sdk/src/a.ts',
		`${slashes} The examplecorps host deploys this through GitHub Actions.\n`,
	)
	write(root, 'packages/sdk/src/b.ts', `${slashes} zorblaxHost runs on GitHub Actions.\n`)

	const result = runAudit(root, ['examplecorp', 'zorblax=exact'])
	assert.equal(result.status, 1, result.stderr)
	const withheld = '    (line withheld: it would print part of NAMZU_DOWNSTREAM_NAMES)'
	for (const path of ['packages/sdk/src/a.ts', 'packages/sdk/src/b.ts']) {
		assert.ok(
			result.stderr.includes(`\n  ${path}:1  [github actions]\n${withheld}\n`),
			result.stderr,
		)
	}
	assert.doesNotMatch(result.stdout + result.stderr, /examplecorp|zorblax/i)
	assert.doesNotMatch(result.stderr, /\[downstream name\]/)
})

test('a structural failure names the file it could not read, redacted', () => {
	const root = repository()
	symlinkSync('missing.md', join(root, 'packages/sdk/src/examplecorp.md'))

	const result = runAudit(root, ['examplecorp'])
	assert.equal(result.status, 2, result.stderr)
	assert.match(result.stderr, /the authored file packages\/sdk\/src\/\*\*\*\.md could not be read/)
	assert.doesNotMatch(result.stderr, /examplecorp/i)
})

test('a longer word that only begins with a downstream name is another word', () => {
	const root = repository()
	write(
		root,
		'packages/sdk/src/words.ts',
		'// an acmeish word, and acmes of them\nexport const acmeless = 1\n',
	)
	assert.equal(runAudit(root, ['acme']).status, 0)
	write(root, 'packages/sdk/src/words.ts', 'export const acmeHost = 1\n')
	assert.equal(runAudit(root, ['acme']).status, 1)
})

test('the matcher agrees with its own cases, and no script carries a list', async () => {
	const { matcherSelfCheck } = await import('../downstream-names.mjs')
	assert.deepEqual(matcherSelfCheck(), [])
	// The list is the secret and never a file. A digest of a name is a trace of
	// it too, so no downstream-name script carries a 64-hex value but the one
	// kept-line digest, which hashes a line the tree already carries verbatim.
	for (const [file, digests] of [
		['downstream-names.mjs', 1],
		['check-downstream-names.mjs', 0],
		['audit-external-names.mjs', 0],
	] as const) {
		const source = readFileSync(join(here, '..', file), 'utf8')
		assert.equal(source.match(/[0-9a-f]{64}/g)?.length ?? 0, digests, file)
	}
})

/**
 * The lines of the step named `name` in a workflow: from its `- name:` line to
 * the next step at the same indentation or the end of its job.
 */
function workflowStep(workflow: string, name: string): string {
	const path = join(here, '..', '..', '.github/workflows', workflow)
	const lines = readFileSync(path, 'utf8').split('\n')
	const start = lines.findIndex((line) => line.trim() === `- name: ${name}`)
	assert.notEqual(start, -1, `${workflow} has no step named "${name}"`)
	const indent = lines[start].indexOf('-')
	const block = [lines[start]]
	for (const line of lines.slice(start + 1)) {
		if (line.trim() === '' || line.trim().startsWith('#')) continue
		if (line.search(/\S/) <= indent) break
		block.push(line)
	}
	return block.join('\n')
}

for (const workflow of ['ci.yml', 'release.yml']) {
	test(`${workflow} passes the secret to the External-name audit step, and to no other`, () => {
		const step = workflowStep(workflow, 'External-name audit')
		assert.match(
			step,
			/\n {8}env:\n {10}NAMZU_DOWNSTREAM_NAMES: \$\{\{ secrets\.NAMZU_DOWNSTREAM_NAMES \}\}\n/,
		)
		assert.match(step, /&& node scripts\/audit-external-names\.mjs\s*$/)
		assert.doesNotMatch(step, /--without-downstream-names/)
		const text = readFileSync(join(here, '..', '..', '.github/workflows', workflow), 'utf8')
		assert.equal(text.match(/secrets\.NAMZU_DOWNSTREAM_NAMES/g)?.length, 1)
	})
}

test('release.yml runs the External-name audit even when CI validated the tree', () => {
	// A ci.yml run for a pull request from a fork gets no secrets, skips the
	// downstream-name rule, and still records its tree as validated.
	assert.doesNotMatch(workflowStep('release.yml', 'External-name audit'), /\n\s+if:/)
})
