/**
 * Tests for scripts/check-downstream-names.mjs.
 *
 * Each case builds a real repository with a base commit and a pull request's
 * commits on top, writes the event file the workflow would hand the script,
 * and runs it as CI does. The listed name is the placeholder `examplecorp`,
 * passed in `NAMZU_DOWNSTREAM_NAMES` as the secret would carry it, so that this
 * file names no one; not `acme`, because the script's own advice suggests
 * `acme` by name and a test that a refusal never repeats the name has to be
 * able to tell the two apart. Nothing about the list or the CI runner is
 * inherited from the process running the tests: in CI, that holds the real
 * list.
 *
 * `scripts/__tests__/` belongs to no package, so `pnpm -r test` never reaches
 * this file; the External-name audit step names it.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const check = join(here, '..', 'check-downstream-names.mjs')
const NAME = 'examplecorp'
const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Git that reads no configuration of the machine running the tests. */
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_AUTHOR_NAME: 'Test',
	GIT_AUTHOR_EMAIL: 'test@example.invalid',
	GIT_COMMITTER_NAME: 'Test',
	GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

function git(root: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: GIT_ENV }).trim()
}

function scratch(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix))
	roots.push(root)
	return root
}

/**
 * Writes `files`, commits exactly those paths, and returns the new commit.
 * `identity` overrides the author or committer variables for this commit.
 */
function commit(
	root: string,
	files: Record<string, string>,
	message: string,
	identity: Record<string, string> = {},
): string {
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true })
		writeFileSync(join(root, path), text, 'utf8')
	}
	git(root, 'add', '--', ...Object.keys(files))
	execFileSync('git', ['commit', '-q', '-m', message], {
		cwd: root,
		env: { ...GIT_ENV, ...identity },
	})
	return git(root, 'rev-parse', 'HEAD')
}

function repository(files: Record<string, string> = { 'README.md': '# Project\n' }) {
	const root = scratch('namzu-downstream-pr-')
	git(root, 'init', '-q', '-b', 'main')
	const base = commit(root, files, 'chore: base')
	return { root, base }
}

interface PullRequest {
	base: string
	head: string
	title?: string
	body?: string | null
	ref?: string
	/** The repository the head branch is in; a fork's differs from the base's. */
	headRepository?: string | null
}

function pullRequestEvent(pr: PullRequest): string {
	const path = join(scratch('namzu-downstream-event-'), 'event.json')
	const event = {
		action: 'edited',
		pull_request: {
			number: 7,
			title: pr.title ?? 'fix(sdk): tidy the wording',
			body: pr.body === undefined ? 'Plain words.' : pr.body,
			head: {
				ref: pr.ref ?? 'fix/tidy',
				sha: pr.head,
				repo:
					pr.headRepository === null ? null : { full_name: pr.headRepository ?? 'example/project' },
			},
			base: { ref: 'main', sha: pr.base, repo: { full_name: 'example/project' } },
		},
	}
	writeFileSync(path, JSON.stringify(event), 'utf8')
	return path
}

function eventFile(event: unknown): string {
	const path = join(scratch('namzu-downstream-event-'), 'event.json')
	writeFileSync(path, JSON.stringify(event), 'utf8')
	return path
}

/** What a case never inherits from the process running the tests. */
const INHERITED = [
	'NAMZU_DOWNSTREAM_NAMES',
	'GITHUB_ACTIONS',
	'GITHUB_EVENT_NAME',
	'GITHUB_EVENT_PATH',
]

/**
 * `names` is the list for this run, one entry per line; `[]` leaves
 * `NAMZU_DOWNSTREAM_NAMES` unset. `env` sets a variable, or with `undefined`
 * removes one; `args` follow `--event`.
 */
function runCheck(
	root: string,
	event: string,
	names: string[] = [NAME],
	env: Record<string, string | undefined> = {},
	args: string[] = [],
) {
	const base: Record<string, string | undefined> = { ...process.env }
	for (const key of INHERITED) delete base[key]
	if (names.length > 0) base.NAMZU_DOWNSTREAM_NAMES = names.join('\n')
	Object.assign(base, env)
	for (const [key, value] of Object.entries(base)) if (value === undefined) delete base[key]
	return spawnSync(process.execPath, [check, '--event', event, ...args], {
		cwd: root,
		encoding: 'utf8',
		env: base as NodeJS.ProcessEnv,
	})
}

/** The variables the CI runner sets for a run triggered by `name`, with `event` as its payload. */
function inActions(name: string, event: string): Record<string, string> {
	return { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: event }
}

function assertNeverRepeated(result: { stdout: string; stderr: string }) {
	assert.doesNotMatch(result.stdout, new RegExp(NAME, 'i'))
	assert.doesNotMatch(result.stderr, new RegExp(NAME, 'i'))
}

test('a clean pull request passes and says what it read', () => {
	const { root, base } = repository()
	const head = commit(root, { 'packages/sdk/src/a.ts': 'export const a = 1\n' }, 'fix(sdk): add a')

	const result = runCheck(root, pullRequestEvent({ base, head }))
	assert.equal(result.status, 0, result.stderr)
	assert.match(
		result.stdout,
		/No downstream consumer name in pull request #7: PR title, PR body, head branch, 1 commit\(s\) \(message, author, committer and added lines\), 1 path\(s\), 1 added line\(s\)\./,
	)
})

test('the title, the body and the head branch name are each read', () => {
	const { root, base } = repository()
	const head = commit(root, { 'a.md': 'a\n' }, 'docs: a')

	const title = runCheck(root, pullRequestEvent({ base, head, title: 'fix: ExampleCorp crash' }))
	assert.equal(title.status, 1, title.stderr)
	assert.match(title.stderr, /\n {2}PR title {2}\[downstream name\]\n {4}fix: \*\*\* crash\n/)
	assertNeverRepeated(title)

	const body = runCheck(
		root,
		pullRequestEvent({ base, head, body: 'Why\n\nFound by the examplecorp team.' }),
	)
	assert.equal(body.status, 1, body.stderr)
	assert.match(body.stderr, /PR body:3 {2}\[downstream name\]/)
	assertNeverRepeated(body)

	const ref = runCheck(root, pullRequestEvent({ base, head, ref: 'fix/examplecorp-crash' }))
	assert.equal(ref.status, 1, ref.stderr)
	assert.match(ref.stderr, /head branch {2}\[downstream name\]\n {4}fix\/\*\*\*-crash/)
	assertNeverRepeated(ref)

	// A pull request with no description at all has an empty body, not a crash.
	assert.equal(runCheck(root, pullRequestEvent({ base, head, body: null })).status, 0)
})

test('every commit message between the base and the head is read', () => {
	const { root, base } = repository()
	commit(root, { 'a.md': 'a\n' }, 'docs: a')
	const named = commit(
		root,
		{ 'b.md': 'b\n' },
		'fix(sandbox): keep the pool warm\n\nSeen first in the ExampleCorp-side lifecycle.',
	)
	const head = commit(root, { 'c.md': 'c\n' }, 'docs: c')

	const result = runCheck(root, pullRequestEvent({ base, head }))
	assert.equal(result.status, 1, result.stderr)
	assert.match(
		result.stderr,
		new RegExp(
			`commit ${named.slice(0, 12)}:3 {2}\\[downstream name\\]\\n {4}Seen first in the \\*\\*\\*-side lifecycle\\.`,
		),
	)
	assertNeverRepeated(result)
	// The commits before the base are `main`'s, and are not this pull request's.
	assert.equal(result.stderr.match(/\[downstream name\]/g)?.length, 1)
})

test("every commit's author and committer are read, not only its message", () => {
	// GitHub's squash merge credits each commit author in a `Co-authored-by`
	// trailer on the commit that lands, and a rebase merge keeps the author as
	// it is, so a commit authored from a work address carries its domain onto
	// `main` under a message that names no one.
	const { root, base } = repository()
	const authored = commit(root, { 'a.md': 'a\n' }, 'docs: a', {
		GIT_AUTHOR_NAME: 'Dev',
		GIT_AUTHOR_EMAIL: 'dev@examplecorp.com',
	})
	const committed = commit(root, { 'b.md': 'b\n' }, 'docs: b', {
		GIT_COMMITTER_NAME: 'ExampleCorp CI',
		GIT_COMMITTER_EMAIL: 'ci@example.invalid',
	})

	const result = runCheck(root, pullRequestEvent({ base, head: committed }))
	assert.equal(result.status, 1, result.stderr)
	assert.match(
		result.stderr,
		new RegExp(
			`\\n {2}commit ${authored.slice(0, 12)} author {2}\\[downstream name\\]\\n {4}Dev <dev@\\*\\*\\*\\.com>\\n`,
		),
	)
	assert.match(
		result.stderr,
		new RegExp(
			`\\n {2}commit ${committed.slice(0, 12)} committer {2}\\[downstream name\\]\\n {4}\\*\\*\\* CI <ci@example\\.invalid>\\n`,
		),
	)
	// Each identity once: the second commit's author is the clean default.
	assert.equal(result.stderr.match(/\[downstream name\]/g)?.length, 2)
	assertNeverRepeated(result)
})

test('added lines and added paths are read; a removed line is the fix and is not', () => {
	const { root, base } = repository({ 'src/host.ts': "export const host = 'examplecorp'\n" })

	// Removing the only name the base carried passes.
	const removed = commit(
		root,
		{ 'src/host.ts': "export const host = 'the host'\n" },
		'fix: neutral host',
	)
	assert.equal(runCheck(root, pullRequestEvent({ base, head: removed })).status, 0)

	// A line reading `++ …` is a line like any other, with its own number.
	const head = commit(
		root,
		{
			'docs/examplecorp.md': '# Deploying\n',
			'notes.md': 'one\n++ examplecorp note\nthree\n',
		},
		'docs: notes',
	)
	const short = head.slice(0, 12)
	const result = runCheck(root, pullRequestEvent({ base, head }))
	assert.equal(result.status, 1, result.stderr)
	assert.match(
		result.stderr,
		new RegExp(
			`\\n {2}docs/\\*\\*\\*\\.md \\(commit ${short}\\) {2}\\[downstream name\\]\\n {4}\\(the path itself\\)`,
		),
	)
	assert.match(
		result.stderr,
		new RegExp(
			`\\n {2}notes\\.md:2 \\(commit ${short}\\) {2}\\[downstream name\\]\\n {4}\\+\\+ \\*\\*\\* note`,
		),
	)
	assert.doesNotMatch(result.stderr, /src\/host\.ts/)
	assertNeverRepeated(result)
})

test('a name one commit adds and a later commit removes is still refused', () => {
	// A rebase merge lands every commit of the pull request as it is, and
	// `refs/pull/<n>/head` keeps them all reachable whatever the merge. The
	// combined diff of these two commits is clean; the first commit is not.
	const { root, base } = repository()
	const added = commit(root, { 'src/host.ts': "export const host = 'examplecorp'\n" }, 'feat: host')
	const head = commit(root, { 'src/host.ts': "export const host = 'the host'\n" }, 'fix: neutral')
	assert.equal(git(root, 'diff', `${base}...${head}`, '--', 'src/host.ts').includes(NAME), false)

	const result = runCheck(root, pullRequestEvent({ base, head }))
	assert.equal(result.status, 1, result.stderr)
	assert.match(
		result.stderr,
		new RegExp(
			`\\n {2}src/host\\.ts:1 \\(commit ${added.slice(0, 12)}\\) {2}\\[downstream name\\]\\n {4}export const host = '\\*\\*\\*'\\n`,
		),
	)
	assert.equal(result.stderr.match(/\[downstream name\]/g)?.length, 1)
	assert.match(result.stderr, /rewriting that commit/)
	assertNeverRepeated(result)

	// The same for a path: added under a name, then renamed.
	const fresh = repository()
	commit(fresh.root, { 'docs/examplecorp.md': '# Deploying\n' }, 'docs: deploying')
	git(fresh.root, 'mv', 'docs/examplecorp.md', 'docs/deploying.md')
	execFileSync('git', ['commit', '-q', '-m', 'docs: rename'], { cwd: fresh.root, env: GIT_ENV })
	const renamed = runCheck(
		fresh.root,
		pullRequestEvent({ base: fresh.base, head: git(fresh.root, 'rev-parse', 'HEAD') }),
	)
	assert.equal(renamed.status, 1, renamed.stderr)
	assert.match(
		renamed.stderr,
		/\n {2}docs\/\*\*\*\.md \(commit [0-9a-f]{12}\) {2}\[downstream name\]/,
	)
	assertNeverRepeated(renamed)
})

test("a merge inside the pull request is read for what it adds, never for main's lines", () => {
	// The pull request's branch merges `main` back in. What `main` brought is
	// `main`'s, and is not this pull request's to answer for, even a line that
	// carries a name; what the merge itself adds, beyond both parents, is.
	const { root, base: start } = repository({ 'shared.md': 'one\n' })
	const branchTip = commit(root, { 'a.md': 'a\n' }, 'docs: a')
	git(root, 'checkout', '-q', '-b', 'upstream', start)
	const base = commit(root, { 'main.md': 'written for examplecorp on main\n' }, 'docs: main')

	/** Merges `upstream` into a new branch at `branchTip`, adding `files`. */
	function mergeMain(branch: string, files: Record<string, string>): string {
		git(root, 'checkout', '-q', '-b', branch, branchTip)
		execFileSync('git', ['merge', '-q', '--no-ff', '--no-commit', 'upstream'], {
			cwd: root,
			env: GIT_ENV,
		})
		for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text, 'utf8')
		git(root, 'add', '--', 'main.md', ...Object.keys(files))
		execFileSync('git', ['commit', '-q', '-m', `Merge main into ${branch}`], {
			cwd: root,
			env: GIT_ENV,
		})
		return git(root, 'rev-parse', 'HEAD')
	}

	const clean = mergeMain('topic', {})
	const quiet = runCheck(root, pullRequestEvent({ base, head: clean }))
	assert.equal(quiet.status, 0, quiet.stderr)
	assert.match(quiet.stdout, /2 commit\(s\)/)

	const evil = mergeMain('evil', { 'shared.md': 'one\nresolved for examplecorp\n' })
	const result = runCheck(root, pullRequestEvent({ base, head: evil }))
	assert.equal(result.status, 1, result.stderr)
	assert.match(
		result.stderr,
		new RegExp(`\\n {2}shared\\.md:2 \\(commit ${evil.slice(0, 12)}\\) {2}\\[downstream name\\]`),
	)
	assert.equal(result.stderr.match(/\[downstream name\]/g)?.length, 1)
	assertNeverRepeated(result)
})

test('a merge group reads the commits about to land', () => {
	const { root, base } = repository()
	const head = commit(root, { 'a.md': 'a\n' }, 'fix: examplecorp crash (#7)')

	const event = eventFile({
		action: 'checks_requested',
		merge_group: { base_sha: base, head_sha: head },
	})
	const result = runCheck(root, event)
	assert.equal(result.status, 1, result.stderr)
	assert.match(result.stderr, /in the merge group/)
	assert.match(result.stderr, /commit [0-9a-f]{12}:1 {2}\[downstream name\]/)
	assertNeverRepeated(result)
})

test('a kept release-history line is exempt in an added line only as that exact line', () => {
	// `ToolCatalogSurface`, which the kept line carries, stands in for a listed
	// name. The old member value the line quotes is a listed name this file
	// never spells: it is read from the changelog at run time and only ever
	// passed to the check as part of its list, so anything printed redacts it.
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
	const names = ['ToolCatalogSurface', member]

	const { root, base } = repository()
	const keptOnly = commit(root, { 'CHANGELOG.md': `${kept}\n` }, 'docs: history')
	assert.equal(runCheck(root, pullRequestEvent({ base, head: keptOnly }), names).status, 0)

	const head = commit(root, { 'CHANGELOG.md': `${kept} Also.\n` }, 'docs: more history')
	const result = runCheck(root, pullRequestEvent({ base, head }), names)
	assert.equal(result.status, 1, result.stderr)
	assert.match(
		result.stderr,
		/\n {2}CHANGELOG\.md:1 \(commit [0-9a-f]{12}\) {2}\[downstream name\]\n {4}- `\*\*\*`: the `'\*\*\*'` member/,
	)
})

test('without NAMZU_DOWNSTREAM_NAMES a run fails, but a pull request from a fork in GitHub Actions skips with a notice', () => {
	const { root, base } = repository()
	const head = commit(root, { 'src/host.ts': "export const host = 'examplecorp'\n" }, 'feat: host')

	// Locally, with nothing set: a failure that names the variable.
	const local = runCheck(root, pullRequestEvent({ base, head }), [])
	assert.equal(local.status, 2, local.stderr)
	assert.match(local.stderr, /^NAMZU_DOWNSTREAM_NAMES is not set\. /)
	assert.equal(local.stdout, '')

	// GitHub gives a run for a fork's pull request no secrets; a deleted fork
	// has no head repository at all.
	for (const headRepository of ['contributor/project', null]) {
		const event = pullRequestEvent({ base, head, headRepository })
		const fork = runCheck(root, event, [], inActions('pull_request', event))
		assert.equal(fork.status, 0, fork.stderr)
		assert.match(
			fork.stdout,
			/^::notice title=Downstream names skipped::NAMZU_DOWNSTREAM_NAMES is not set: this run is for a pull request from a fork, and GitHub gives such a run no secrets/,
		)
		assert.equal(fork.stderr, '')
	}

	// A pull request from a branch of this repository gets the secret, so an
	// empty one is a failure, and so is a merge group.
	const sameRepository = pullRequestEvent({ base, head })
	const same = runCheck(root, sameRepository, [], inActions('pull_request', sameRepository))
	assert.equal(same.status, 2, same.stderr)
	assert.match(
		same.stderr,
		/^NAMZU_DOWNSTREAM_NAMES is not set\. This run did not receive the repository secret/,
	)
	const group = eventFile({ merge_group: { base_sha: base, head_sha: head } })
	const queued = runCheck(root, group, [], inActions('merge_group', group))
	assert.equal(queued.status, 2, queued.stderr)
	assert.match(queued.stderr, /^NAMZU_DOWNSTREAM_NAMES is not set\./)

	// With the list, a fork's pull request is read like any other.
	const forkEvent = pullRequestEvent({ base, head, headRepository: 'contributor/project' })
	const read = runCheck(root, forkEvent, [NAME], inActions('pull_request', forkEvent))
	assert.equal(read.status, 1, read.stderr)
	assertNeverRepeated(read)
})

test('--without-downstream-names skips a local run, and is refused in GitHub Actions', () => {
	const { root, base } = repository()
	const head = commit(root, { 'a.md': 'a\n' }, 'docs: a')
	const event = pullRequestEvent({ base, head })

	const local = runCheck(root, event, [], {}, ['--without-downstream-names'])
	assert.equal(local.status, 0, local.stderr)
	assert.match(
		local.stdout,
		/^Downstream-name rule not run: NAMZU_DOWNSTREAM_NAMES is not set and --without-downstream-names was given\./,
	)

	for (const names of [[], [NAME]]) {
		const refused = runCheck(root, event, names, inActions('pull_request', event), [
			'--without-downstream-names',
		])
		assert.equal(refused.status, 2, refused.stderr)
		assert.match(refused.stderr, /^--without-downstream-names is for a local checkout/)
	}
})

test('an =exact entry is refused as a whole word and not inside an identifier', () => {
	const { root, base } = repository()
	const head = commit(
		root,
		{ 'src/a.ts': 'export const zorblaxHost = 1\n' },
		'feat: ZORBLAX_TLS_CA',
	)
	const inside = runCheck(root, pullRequestEvent({ base, head, title: 'feat: zorblaxes' }), [
		'zorblax=exact',
	])
	assert.equal(inside.status, 0, inside.stderr)

	const whole = runCheck(
		root,
		pullRequestEvent({ base, head, title: 'fix: the Zorblax-side crash' }),
		['zorblax=exact'],
	)
	assert.equal(whole.status, 1, whole.stderr)
	assert.match(
		whole.stderr,
		/\n {2}PR title {2}\[downstream name\]\n {4}fix: the \*\*\*-side crash\n/,
	)
	assert.equal(whole.stderr.match(/\[downstream name\]/g)?.length, 1)
	assert.doesNotMatch(whole.stdout + whole.stderr, /zorblax/i)
})

test('commits git cannot find, or an event of another kind, answer "could not establish"', () => {
	const { root, base } = repository()
	const missing = runCheck(root, pullRequestEvent({ base, head: '0'.repeat(40) }))
	assert.equal(missing.status, 2, missing.stderr)
	assert.match(missing.stderr, /git could not read pull request #7/)

	const push = runCheck(root, eventFile({ ref: 'refs/heads/main', after: base }))
	assert.equal(push.status, 2, push.stderr)
	assert.match(push.stderr, /neither a pull request nor a merge group/)

	const noHead = runCheck(root, eventFile({ pull_request: { number: 7, base: { sha: base } } }))
	assert.equal(noHead.status, 2, noHead.stderr)
	assert.match(noHead.stderr, /no head commit/)
})

test('nothing it prints repeats a name, an error about the event included', () => {
	// Findings are not the only text a check prints: an error quotes a path,
	// and CI logs are public.
	const { root } = repository()
	const missing = join(scratch('namzu-downstream-event-'), `${NAME}-event.json`)

	const result = runCheck(root, missing)
	assert.equal(result.status, 2, result.stderr)
	assert.match(result.stderr, /the event \S*\/\*\*\*-event\.json could not be read/)
	assertNeverRepeated(result)
})

test("a finding whose line would still show an entry's text is withheld whole", () => {
	// `examplecorps` is another word to the matcher, so nothing redacts it; the
	// line is reported for the name beside it and printed as a placeholder.
	const { root, base } = repository()
	const head = commit(root, { 'a.md': 'a\n' }, 'docs: a')
	const result = runCheck(
		root,
		pullRequestEvent({ base, head, body: 'Found by the examplecorp team, and examplecorps too.' }),
	)
	assert.equal(result.status, 1, result.stderr)
	assert.ok(
		result.stderr.includes(
			'\n  PR body:1  [downstream name]\n    (line withheld: it would print part of NAMZU_DOWNSTREAM_NAMES)\n',
		),
		result.stderr,
	)
	assertNeverRepeated(result)
})

test('the PR text workflow runs on every edit, over full history, with the secret in its one step', () => {
	// The trigger that makes an edited title or body run it again, and the
	// history the per-commit reading needs, are what make this a check at all.
	// The list is the secret, passed to the step that reads it and to nothing
	// else, and never the local opt-out.
	const workflow = readFileSync(join(here, '..', '..', '.github/workflows/pr-text.yml'), 'utf8')
	assert.match(
		workflow,
		/\n {2}pull_request:\n {4}branches: \[main\]\n {4}types: \[[^\]]*\bedited\b[^\]]*\]\n/,
	)
	assert.match(workflow, /\n {2}merge_group:\n/)
	assert.match(workflow, /\n {10}fetch-depth: 0\n/)
	assert.match(
		workflow,
		/\n {8}env:\n {10}NAMZU_DOWNSTREAM_NAMES: \$\{\{ secrets\.NAMZU_DOWNSTREAM_NAMES \}\}\n {8}run: node scripts\/check-downstream-names\.mjs --event "\$GITHUB_EVENT_PATH"\n/,
	)
	assert.equal(workflow.match(/secrets\./g)?.length, 1)
	assert.doesNotMatch(workflow, /--without-downstream-names/)
	assert.doesNotMatch(workflow, /\$\{\{ github\.event\.pull_request\.(title|body)/)
})

test("AGENTS.md's local gate list runs these tests and names this check", () => {
	// The CI-gates table is what a contributor runs before pushing. A test file
	// only the workflows name is one that list never runs, and a check it does
	// not name is one nobody runs before the pull request opens.
	const agents = readFileSync(join(here, '..', '..', 'AGENTS.md'), 'utf8')
	assert.match(
		agents,
		/\n\| External-name audit \| `node --import tsx --test [^`\n]*scripts\/__tests__\/check-downstream-names\.test\.ts[^`\n]*` \|\n/,
	)
	const step = 'No downstream name in the PR text, commits or added lines'
	const workflow = readFileSync(join(here, '..', '..', '.github/workflows/pr-text.yml'), 'utf8')
	assert.ok(workflow.includes(`\n      - name: ${step}\n`), 'pr-text.yml has no step of that name')
	assert.ok(
		agents.includes(`\n| ${step} | \``),
		'AGENTS.md has no row for the PR text step, under its name in pr-text.yml',
	)
	assert.match(agents, /node scripts\/check-downstream-names\.mjs --event /)
	// How the owner maintains the list, and how a contributor without it runs
	// the rest, are in the same file the gates are.
	assert.ok(agents.includes('`gh secret set NAMZU_DOWNSTREAM_NAMES`'))
	assert.ok(agents.includes('`node scripts/audit-external-names.mjs --without-downstream-names`'))
})

for (const workflow of ['ci.yml', 'release.yml']) {
	test(`${workflow} runs these tests in its External-name audit step`, () => {
		// No package owns `scripts/__tests__/`, so a workflow that does not name
		// this file never runs it.
		const text = readFileSync(join(here, '..', '..', '.github/workflows', workflow), 'utf8')
		assert.match(
			text,
			/- name: External-name audit\n(?: {8}.*\n)*? {8}run: node --import tsx --test [^\n]*scripts\/__tests__\/check-downstream-names\.test\.ts /,
		)
	})
}
