/**
 * The properties `.github/scripts/verify-consumer-install.sh` has to hold: it
 * must give back the tree it was handed, a refusal must say what it refused,
 * and the paths it deletes must be the ones it created.
 *
 * `node:test`, matching `check-log-standard.test.ts` and for the same reason —
 * there is no package to hang a vitest project on here, so `pnpm -r test`
 * cannot see this file at all. It runs in CI in the same step as the gate it
 * proves (`Pre-publish consumer install check`), which is where
 * `check-log-standard.test.ts` runs for the same reason; by hand, run it
 * exactly as CI does:
 *
 *   node --import tsx --test scripts/__tests__/verify-consumer-install-snapshot.test.ts
 *
 * Both paths onto `main` run it there: `ci.yml`'s `Build & Test` job and
 * `release.yml`'s inline validation, each in a step named `Pre-publish consumer
 * install check`. Two different mechanisms hold that, and it is worth being
 * exact about which does what, because only one of them reads a `run:` block:
 *
 *   - `check-workflow-gate-parity.mjs` holds the step NAME on both paths. It
 *     compares the names the two workflows declare: a step present in `ci.yml`
 *     and missing from `release.yml` fails it unless it is exempted by name.
 *     This step was already on both paths, which is why adding this file to it
 *     needed no new exemption there. It never reads a `run:` body.
 *   - `the wiring that runs this file in CI` below holds the BODY: that both
 *     workflows' step still names this file, ahead of the gate. Nothing else
 *     reads it, so a workflow that gained the step and lost the command would
 *     otherwise run the gate and never this.
 *
 * ## Why this test exists
 *
 * The script snapshots the version-carrying files on entry and restores them
 * on exit, because it deliberately mutates every manifest to check what would
 * PUBLISH rather than what is in the tree. The restore does `rm -rf
 * .changeset` and untars the snapshot back.
 *
 * The snapshot was once taken with `git ls-files`, which lists TRACKED files. An
 * uncommitted changeset is by definition untracked, so it was never in the
 * snapshot and the `rm -rf` was the last thing that happened to it. Running
 * this gate — step 14 of the CI table `AGENTS.md` tells every contributor to
 * work before pushing — silently deleted the file that declares what the push
 * was supposed to release.
 *
 * It is asserted here rather than left to review because the loss is
 * invisible: the gate passes, the tree looks fine, and the missing changeset
 * only surfaces when a release publishes nothing.
 *
 * ## And the two properties that came later
 *
 * #415: a refusal the reader cannot read. The install's output has to reach
 * them, the step and line have to be named, and the manifest paths handed to
 * Node have to be paths Node can open — see the middle describes.
 *
 * The cleanup incident: `cleanup` deletes three directories whose names come
 * from variables, and a reviewer who sourced it with `PACK_DIR=/tmp` deleted
 * other people's scratch. See the last describe.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(REPO_ROOT, '.github', 'scripts', 'verify-consumer-install.sh')
const SOURCE = readFileSync(SCRIPT, 'utf8')
const LINES = SOURCE.split('\n')

// Comments talk about the defects on purpose, and prose quoting a defect reads
// exactly like the defect: every source assertion below runs against the code
// with comment lines removed.
const CODE = LINES.filter((line) => !line.trimStart().startsWith('#')).join('\n')

/**
 * Check that an anchor is still in the script, and hand the source back.
 *
 * The whole script packs every package and runs an npm install, which takes
 * minutes and needs a registry. What is under test are a handful of shell
 * fragments, so they are extracted and run against throwaway directories — the
 * same trade `check-log-standard.test.ts` makes by driving the pure AST layer
 * instead of the CLI entry point.
 */
function extract(name: string): string {
	const start = SOURCE.indexOf(name)
	assert.notEqual(start, -1, `${name} is no longer in ${SCRIPT} — this test is stale`)
	return SOURCE
}

/**
 * How many times `name` is DEFINED, in any of the spellings bash accepts.
 *
 * Bash runs the LAST definition of a function and every check in this file
 * reads the first, so a second one is a second behaviour none of them sees:
 * `on_error() { :; }` appended to the end of the file turns the report back off
 * with every source assertion here still passing.
 *
 * Which is why the pattern does not require the definition to own its line.
 * `if true; then on_error() { :; }; fi`, `true && on_error() { :; }` and a body
 * in the subshell form (`on_error() ( : )`) are each accepted by bash — all
 * three were run — and each is counted as ZERO by a pattern anchored on the
 * start of a line, so the second definition runs while this check reports one.
 * So the anchor is the character BEFORE the name, which must not be part of
 * another identifier, and the body may open with either compound-command form
 * bash accepts: `{` or the subshell `(`.
 *
 * What a text scan cannot see is a definition bash only builds at run time —
 * `eval 'on_error() { :; }'`, a function written into a file and sourced. This
 * script has neither, and nothing here claims otherwise.
 */
function definitionCount(name: string, code: string = CODE): number {
	return [...code.matchAll(new RegExp(`(?:^|[^\\w$])${name}\\s*(?:\\(\\s*\\))?\\s*[{(]`, 'gm'))].length
}

/** The text of a `name() { ... }` definition, name to closing brace. */
function shellFunction(name: string): string {
	assert.notEqual(definitionCount(name), 0, `${name}() is no longer defined in ${SCRIPT} — this test is stale`)
	assert.equal(
		definitionCount(name),
		1,
		`${name}() is defined more than once in ${SCRIPT}: the shell runs the LAST definition and every check here is written against the first, so what is asserted here may not be what runs`,
	)
	const start = SOURCE.indexOf(`\n${name}() {\n`)
	assert.notEqual(start, -1, `${name}() is no longer in ${SCRIPT} — this test is stale`)
	const end = SOURCE.indexOf('\n}\n', start)
	assert.notEqual(end, -1, `${name}() is not closed by a brace in column 0 — this test is stale`)
	return SOURCE.slice(start + 1, end + 2)
}

/**
 * Run a shell fragment and hand back its status and both streams, whether or
 * not it succeeded. The fragments below are *supposed* to fail: a helper that
 * threw on the expected path would hide what they printed.
 *
 * `cwd` is for the one probe that stands in for the script's install, which
 * runs from inside the consumer directory: npm reads `.npmrc` from the
 * directory it is run in, so the stub npm reports the one a real npm would.
 *
 * npm's own configuration variables — `npm_config_*`, in any case — are
 * removed from the environment a probe starts from, and the explicit `env`
 * argument is applied AFTER that, so a probe can hand one back deliberately.
 * The stub npm refuses any it is given, and the removal is what lets that
 * refusal mean "any the fragment set" rather than "any the host happened to
 * export": a CI image that has run an npm script, a developer's shell with a
 * registry override, would otherwise fail the suite for a fact about the host.
 */
function runProbe(fragment: string, env: NodeJS.ProcessEnv = {}, cwd?: string) {
	const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !NPM_CONFIG_ENV.test(key)))
	const result = spawnSync('bash', ['-c', fragment], { encoding: 'utf8', cwd, env: { ...inherited, ...env } })
	return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('the snapshot/restore round trip', () => {
	const scratch = mkdtempSync(join(tmpdir(), 'namzu-snapshot-'))
	after(() => rmSync(scratch, { recursive: true, force: true }))

	it('gives back an UNTRACKED changeset, which is what every new one is', () => {
		const workspace = join(scratch, 'ws')
		const snapshot = join(scratch, 'snap')
		execFileSync('mkdir', ['-p', join(workspace, '.changeset'), snapshot])
		execFileSync('git', ['init', '-q'], { cwd: workspace })

		// One committed and one not, so the test can tell "restored everything"
		// from "restored only what git knew about" — which is exactly the
		// distinction the defect turned on.
		writeFileSync(join(workspace, '.changeset', 'config.json'), '{}')
		execFileSync('git', ['add', '.changeset/config.json'], { cwd: workspace })
		execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed'], {
			cwd: workspace,
		})
		writeFileSync(join(workspace, '.changeset', 'brand-new.md'), '---\n---\nnot committed yet\n')

		// The snapshot half, verbatim in shape from the script.
		execFileSync('bash', ['-c', 'cd "$1" && tar cf - .changeset | (cd "$2" && tar xf -)', '_', workspace, snapshot])
		// The restore half, verbatim in shape from the script.
		execFileSync(
			'bash',
			['-c', 'rm -rf "$1/.changeset" && (cd "$2" && tar cf - .) | (cd "$1" && tar xf -)', '_', workspace, snapshot],
		)

		assert.ok(
			existsSync(join(workspace, '.changeset', 'brand-new.md')),
			'an uncommitted changeset did not survive the round trip',
		)
		assert.ok(existsSync(join(workspace, '.changeset', 'config.json')))
	})

	it('the script snapshots .changeset from DISK, not from the index', () => {
		const source = extract('VERSION_SNAPSHOT=$(mktemp')

		// The specific regression. `git ls-files` over `.changeset/*` is what
		// dropped untracked changesets, and it reads as correct at first glance.
		assert.ok(
			!/git ls-files[^\n]*\.changeset/.test(source),
			'`.changeset` is snapshotted through `git ls-files` again, which cannot see an uncommitted changeset',
		)
		assert.ok(
			/tar cf - \.changeset/.test(source),
			'`.changeset` is no longer snapshotted from disk',
		)
	})

	it('still restores the manifests it deliberately rewrites', () => {
		// The other half of the script's contract, asserted so a fix to the
		// above cannot be "stop snapshotting anything". These are read from disk
		// too, so a new untracked package survives the local release preview.
		const source = extract('VERSION_SNAPSHOT=$(mktemp')
		assert.ok(/find packages[\s\S]*-name package\.json/.test(source))
		assert.ok(/find packages[\s\S]*-name CHANGELOG\.md/.test(source))
	})
})

/**
 * `find ... -print -quit`, and not `find ... -print | head -1`.
 *
 * The pipe is a real defect that hid behind a small `.changeset/`, and it is
 * documented at length on the line itself: under `set -euo pipefail`, `head -1`
 * closing the pipe after one line sends `find` SIGPIPE, the pipeline reports
 * 141, and `set -e` ends the run before it does any of its work. With two or
 * three changesets `find` finishes before `head` exits and nothing happens, so
 * the gate passed for as long as nobody had a large batch pending and started
 * exiting silently at 141 the moment somebody did.
 *
 * A property about a shell idiom rather than about this script's text, which is
 * why it is asserted twice: for the line that reads the pending changesets, and
 * for every `find` in the file.
 */
describe('reading the pending changesets', () => {
	const PENDING = 'PENDING_CHANGESETS=$(find'

	it('asks find for one line, instead of piping it into a reader that exits early', () => {
		const line = LINES.find((candidate) => candidate.includes(PENDING))
		assert.notEqual(line, undefined, `the pending-changesets read is gone from ${SCRIPT} — this test is stale`)
		assert.match(
			line ?? '',
			/-print -quit\b/,
			`the pending-changesets read no longer stops find after one line, so a large .changeset/ makes it write into a closed pipe:\n  ${line?.trim()}`,
		)
		assert.doesNotMatch(
			line ?? '',
			/\|\s*head\b/,
			`the pending-changesets read pipes find into head again: under \`set -euo pipefail\` the SIGPIPE that closes it ends the run at 141 before any of the gate's work:\n  ${line?.trim()}`,
		)
	})

	it('pipes no find anywhere into a reader that exits after one line', () => {
		const piping = LINES.flatMap((line, index) =>
			isComment(line) || !/\bfind\b/.test(line) || !/\|\s*head\b/.test(line) ? [] : [{ at: lineOffset(index), line }],
		)
		assert.equal(
			piping.length,
			0,
			`a find is piped into head, which is the 141 this file documents:\n${piping
				.map((entry) => `  ${entry.line.trim()}`)
				.join('\n')}`,
		)
	})
})

describe('the live minimum-SDK fixture', () => {
	it('uses the packed SDK when the lower bound is the release being gated', () => {
		const source = extract('SHIPPING_SDK_VERSION=')

		assert.match(source, /if \[ "\$LIVE_MINIMUM_SDK" = "\$SHIPPING_SDK_VERSION" \]/)
		assert.match(source, /minimum is the shipping SDK; packed fixture above covers it/)
		assert.match(source, /else[\s\S]*"@namzu\/sdk@\$LIVE_MINIMUM_SDK"/)
	})
})

/**
 * A line that RUNS an npm install, as opposed to one that prints it back to
 * the reader. `npm init` is not an install and is deliberately not matched.
 */
const LAUNCHES_INSTALL = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*npm\s+(?:install|i|add)\b/

/**
 * Every spelling that makes npm withhold the ERROR rather than the progress,
 * in argv where the launch line and the executed argv check can both see it.
 *
 * `-s` and `--loglevel silent` were measured against npm 11.17.0 to reproduce
 * `--silent` exactly: nothing on stdout, nothing on stderr, exit 254. `-q` is
 * narrower than the rest — it only quiets to `warn` — and is refused all the
 * same, because the one install this script runs is the one whose output is
 * the answer.
 *
 * argv is not the only way in, and it is not where the two below come from: an
 * argv is what a source scan can read off a line, and what the executed check
 * can read off a real command, but neither one sees a setting that arrives in
 * the environment or in a config file.
 */
const SILENT = /(?:^|\s)(?:-s|--silent|-q|--quiet|--loglevel[= ]silent|--log-level[= ]silent)(?=\s|$)/

/**
 * The two ways npm is silenced that never reach argv: a variable in its
 * environment, and a line in a config file.
 *
 * Measured against npm 11.17.0 with a tarball that cannot exist.
 * `npm install --no-fund --no-audit --no-save /tmp/absent.tgz` writes 569 bytes
 * of npm's own error to stderr and exits 254. The same command with
 * `npm_config_loglevel=silent` exits 254 with **nothing on either stream**, and
 * with any value npm does not recognise as one of its own level names — `0`,
 * `1`, `2`, `3`, `off`, `disabled`, `false`, `no`, `banana`, each run — it
 * exits 1 with **nothing on either stream**. npm does not reject a level it
 * cannot name; it ends up with no reporter at all. Only the names it knows
 * (`error`, `warn`, `notice`, `http`, `info`, `verbose`, `silly`) print
 * anything, and `error` prints less than the default it replaces.
 *
 * So a check written for the literal `silent` catches almost none of this, and
 * a check that reads the VALUE catches nothing at all when the value is built
 * (`npm_config_loglevel=$LEVEL`). The ban is therefore on the assignment
 * itself: any case, any value. That is how npm reads it too — the variable name
 * is matched case-insensitively, so `NPM_CONFIG_LOGLEVEL=0` is the same thing,
 * and the key is lowercased, so `npm_config_logLevel=0` is as well.
 *
 * `NPM_CONFIG_ENV` is deliberately wider than the one key that silences, for
 * the reason the `.npmrc` ban is: what is asserted is that this script adds
 * NOTHING to npm's environment, so there is no variable of its making for a
 * later edit to put the level in — for every spelling the text of the file
 * builds, which is the bound at the end of this comment. The other knobs that
 * could suppress output were looked for and `loglevel` is the only one —
 * `npm_config_log_level` is a different key npm merely warns about, and
 * `npm_config_silent` and `npm_config_quiet` are not keys at all — so a ban on
 * the prefix is also the one that cannot go stale if npm grows another.
 *
 * What a text scan cannot see is a name the text never spells. Quoting does not
 * hide the token — that is what `bashText` undoes — but a name no piece of the
 * file contains is a name no scan of the file finds: a variable of a variable
 * assembled from fragments of the word (`P=npm; K=config_loglevel;
 * export "${P}_${K}=0"`), a name a program prints (`printf 'npm_confi%s'
 * g_loglevel`, where the `%s` is the split), an `eval` of a string built
 * anywhere but here. This script has none of the three, and nothing here claims
 * a scan would catch one — the bound the `on_error` count above states about a
 * definition bash only builds at run time, stated here for npm's environment.
 *
 * The executed check is the other half of that bound, and the narrower one: it
 * replays `run_install` and nothing else, so the environment it hands the stub
 * is the environment that body builds. A line outside that body — the
 * top-of-file `export` this scan exists for — is asked of no executed check at
 * all. Together the two cover the text of this file and one function's
 * environment; neither covers npm's environment in general.
 */
const NPM_CONFIG_ENV = /npm_config_/i

/**
 * The third spelling, and the one that is not a value at all.
 *
 * `loglevel` is npm's config key, and npm reads it from a config file after it
 * reads the environment, so a file is a way in that has no variable in it. It
 * is also settable without naming a file: `npm config set loglevel off
 * --location=project` writes one, and a check written for the value `silent`
 * reads that line as nothing.
 *
 * So the ban is on the WORD, everywhere in the script's code, exactly as the
 * ban above is on npm's environment prefix: this script has no business naming
 * npm's log level in any spelling, and a name it does not mention is a name no
 * later edit can set. Refusing the `.npmrc` name as well is the same statement
 * made about the file: this script adds nothing to npm's configuration, so
 * there is no config of its making for an edit to put a level in.
 */
const SILENT_CONFIG = /loglevel/i

/**
 * The spellings that leave the shell without its ERR report.
 *
 * Each was executed against bash with the trap installed the way the script
 * installs it — the handler defined, then `trap on_error ERR` — and a failure
 * inside a function behind it: the control run printed the handler's TRAPFIRED,
 * and each spelling below printed nothing at all. `trap - ERR` and `trap ERR`
 * reset the trap (a signal name with no action is the same reset), `trap -- ERR`
 * is that reset after the end-of-options marker, and `trap '' ERR` /
 * `trap "" ERR` are an EMPTY action, which REPLACES the handler with a no-op
 * rather than resetting it — the report is lost either way. The signal name is
 * case-insensitive because bash takes `err` and `Err` too. `set +E` does not
 * remove the trap, it stops it being inherited by functions, which is the same
 * thing for every failure inside one; `set +o errtrace` and
 * `shopt -u -o errtrace` unset that same option by its long name.
 *
 * What is NOT here is every other `set +…`, and that is the correction: a
 * pattern for `set\s+\+[A-Za-z]` also matches `set +u`, `set +B`, `set +m` and
 * `set +o pipefail`, and each of those was run the same way — TRAPFIRED printed
 * for all four, so none of them disarms anything and a check that refuses them
 * refuses a line that is not a defect. `set +e` is not here either: it removes
 * the abort, not the report (TRAPFIRED printed, and the run continued), and the
 * script's own `set -Eeuo pipefail` is asserted on its own line below.
 *
 * Deliberately not anchored at the end of the line: `trap - ERR; whatever` is
 * a disarm too.
 *
 * Both halves of that list are run against this host's bash by the test beside
 * the guard, rather than taken on trust here: every spelling on it must lose
 * the report and every `set` spelling off it must keep it, or the test says
 * which line was classified wrongly.
 */
const DISARMS_ERROR_REPORTING = new RegExp(
	`^\\s*(?:${[
		'set\\s+\\+E',
		'set\\s+\\+\\s*-?o\\s+errtrace',
		'shopt\\s+-u\\s+-o\\s+errtrace',
		'trap\\s+(?:--?\\s+)?[Ee][Rr][Rr]',
		'trap\\s+(?:--?\\s+)?(?:\'\'|"")\\s+[Ee][Rr][Rr]',
	].join('|')})`,
)

const isComment = (line: string) => line.trimStart().startsWith('#')

/**
 * A backslash at the end of a line, where it is not itself escaped, joins that
 * line to the next one and bash reads the join. An even run does not: `even\\`
 * is an escaped backslash and the newline ends the line. Both were run —
 * `echo odd-\` + `joined` prints `odd-joined`, and `echo even\\` + `joined`
 * runs `joined` as a command of its own. A comment is not continued by one:
 * `# ... \` + a command runs the command, which is why the exemption below can
 * skip a comment line without looking at what follows it.
 */
const CONTINUES_ONTO_THE_NEXT_LINE = /(?:^|[^\\])(?:\\\\)*\\$/

/**
 * The text bash would read for `lines[index]`, and the line that text ends on.
 * The name a shell hands npm is a word it BUILDS, and two spellings build
 * `npm_config_loglevel=0` out of pieces a page shows separately: adjacent
 * quoted fragments, and the halves of a line joined by a continuation. Both
 * were measured — `env` prints `npm_config_loglevel=0` for
 * `export "npm_confi""g_lo""glevel=0"` and for `export npm_confi\` +
 * `g_loglevel=0` alike.
 *
 * So the quoting is undone and the continuation folded before anything is
 * matched: a scan for a name has to read the name, not the page. What it still
 * cannot see is stated on `NPM_CONFIG_ENV`.
 */
function bashText(lines: string[], index: number): { text: string; through: number } {
	let through = index
	let raw = lines[index]
	while (CONTINUES_ONTO_THE_NEXT_LINE.test(raw) && through + 1 < lines.length) {
		through += 1
		raw = `${raw.slice(0, -1)}${lines[through]}`
	}
	return { text: raw.replace(/["']/g, ''), through }
}

/**
 * Every non-comment line of `lines` that hands npm a way to withhold its own
 * error: a variable in its environment, a log level in a config file, or an
 * `.npmrc` for one to be written into. The three are one question, which is why
 * they are one scan — a reader adding a fourth spelling adds it here and both
 * the assertion over the shipped script and the spelling table below pick it up.
 *
 * The question is asked of the text bash would read (`bashText`), so a name
 * split into quoted fragments is the name it builds and not three words. What
 * comes back is the line as the file has it: a continuation is handed back
 * whole, so a report names the line a reader will find rather than the half of
 * it the match landed on.
 */
function silencingLines(lines: string[]): string[] {
	const flagged: string[] = []
	for (let index = 0; index < lines.length; index += 1) {
		if (isComment(lines[index])) continue
		const { text, through } = bashText(lines, index)
		if (NPM_CONFIG_ENV.test(text) || SILENT_CONFIG.test(text) || text.includes('.npmrc')) {
			flagged.push(lines.slice(index, through + 1).join('\n'))
		}
		index = through
	}
	return flagged
}

/** The character offset a line starts at, so line-order facts survive edits. */
function lineOffset(index: number): number {
	return LINES.slice(0, index).reduce((total, line) => total + line.length + 1, 0)
}

/**
 * The programs this script hands Node inline: `node -p "..."`, the multi-line
 * `node -e '...'`. Shell quoting ends at the first matching quote, which is
 * where the shell ends it too.
 */
function inlineNodePrograms(): Array<{ flag: string; body: string }> {
	const programs: Array<{ flag: string; body: string }> = []
	for (const match of CODE.matchAll(/\bnode\s+(-p|-e|--eval|--print)\s+/g)) {
		const start = (match.index ?? 0) + match[0].length
		const quote = CODE[start]
		assert.ok(
			quote === "'" || quote === '"',
			`\`node ${match[1]}\` is no longer followed by a quoted program — this test is stale`,
		)
		let end = start + 1
		while (end < CODE.length && CODE[end] !== quote) {
			end += CODE[end] === '\\' && quote === '"' ? 2 : 1
		}
		programs.push({ flag: match[1], body: CODE.slice(start + 1, end) })
	}
	return programs
}

/**
 * Every string literal handed to a module system in this file, heredocs
 * included.
 *
 * `require(process.argv[1])` is deliberately not one of these — an argv is the
 * form that is supposed to be there — and it is why the check beside this one
 * exists: a path spliced into the program string is spliced just as well as
 * one spliced into a literal.
 */
function moduleLiterals(): Array<{ quote: string; body: string }> {
	const literals: Array<{ quote: string; body: string }> = []
	const openers = /\b(?:require|import)\s*\(\s*|\bfrom\s+(?=['"`])/g
	for (const match of CODE.matchAll(openers)) {
		const start = (match.index ?? 0) + match[0].length
		const quote = CODE[start]
		if (quote !== "'" && quote !== '"' && quote !== '`') continue
		let end = start + 1
		while (end < CODE.length && CODE[end] !== quote) {
			end += CODE[end] === '\\' ? 2 : 1
		}
		literals.push({ quote, body: CODE.slice(start + 1, end) })
	}
	return literals
}

/**
 * The stub npm's refusal, and the status it leaves with.
 *
 * The refusal is in the stub — the executed path — rather than in an assertion
 * over a string the stub printed. A check that reads back a recorded value can
 * be defeated by replacing that value with a constant while the run stays
 * green; a check that reads back the run's own status cannot, because the run
 * is the thing that failed. The recorded lines stay, as the diagnosis a reader
 * gets when the refusal fires.
 */
const STUB_REFUSED = 'npm-stub-refused-config'
const STUB_REFUSED_STATUS = 91

/**
 * A stub npm that refuses the way a registry refusal looks — npm's error on
 * stderr, its own non-zero status — and refuses anything that would have kept
 * a real npm from saying so.
 *
 * It is asked the three questions the argv a command is handed cannot see: the
 * environment it inherits, and the config file npm reads from the directory it
 * runs in. `runProbe` removes npm's configuration variables from that
 * environment before this stub is ever reached, so a variable it finds is one
 * the fragment set.
 */
function writeStubNpm(bin: string): void {
	writeFileSync(
		join(bin, 'npm'),
		`#!/usr/bin/env bash
printf '%s\\n' "argv: $*"
printf '%s\\n' "npm_config env: $(env | grep -i '^npm_config_' | sort | tr '\\n' ' ')"
printf '%s\\n' "npmrc: $(cat ./.npmrc 2>/dev/null | tr '\\n' ' ')"

leaked=$(env | grep -i '^npm_config_' || true)
config=$(grep -i 'loglevel' ./.npmrc 2>/dev/null || true)
if [ -n "$leaked" ] || [ -n "$config" ]; then
  echo "${STUB_REFUSED}: this install was handed a way to withhold npm's error" >&2
  [ -n "$leaked" ] && echo "  npm_config: $(printf '%s' "$leaked" | tr '\\n' ' ')" >&2
  [ -n "$config" ] && echo "  .npmrc: $(printf '%s' "$config" | tr '\\n' ' ')" >&2
  exit ${STUB_REFUSED_STATUS}
fi

echo "npm error code ERESOLVE" >&2
echo "npm error While resolving: namzu-consumer" >&2
exit 17
`,
	)
	chmodSync(join(bin, 'npm'), 0o755)
}

/**
 * The fragment the install probes all share: the shipped `run_install`, and one
 * launch through it asking for a tarball that cannot exist.
 */
function installProbe(): string {
	return [
		'set -Eeuo pipefail',
		'CURRENT_STEP="the step under test"',
		shellFunction('run_install'),
		'run_install /probe/namzu-sdk-1.2.3.tgz',
		'',
	].join('\n')
}

/**
 * The other half of the script's contract, and the one #415 was filed about:
 * when it says no, the reader can see what it said no to.
 *
 * Two independent defects made a refusal unreadable. `--silent` on every
 * `npm install` suppresses the ERROR, not just progress, so `set -e` aborted
 * a gate that packs every publishable package with a bare exit code and no
 * npm output at all — "the registry blipped" and "this change broke a peer
 * range" produced the same CI log. And `node -p "require('$WORKSPACE_ROOT/
 * ...')"` handed Git Bash's `/c/Users/...` to a native Windows Node that
 * cannot open it.
 *
 * Every one of these is a property, not a spelling, and each was proven by
 * running the mutation it is meant to catch: a mutation has to FAIL this file,
 * and the shipped script has to pass it.
 */
describe('a refusal says what it refused', () => {
	it('launches npm only from run_install, and never with a silent flag', () => {
		const launches = LINES.flatMap((line, index) =>
			isComment(line) || !LAUNCHES_INSTALL.test(line) ? [] : [{ at: lineOffset(index), line }],
		)

		// One launch, and it is the one whose output is captured and printed
		// under the package that failed. A second one anywhere is an install
		// whose failure is a bare exit code again.
		assert.equal(
			launches.length,
			1,
			`npm install must run only inside run_install; found ${launches.length}:\n${launches
				.map((launch) => `  ${launch.line.trim()}`)
				.join('\n')}`,
		)

		const body = shellFunction('run_install')
		const bodyStart = SOURCE.indexOf(body)
		assert.ok(
			launches[0].at > bodyStart && launches[0].at < bodyStart + body.length,
			`the one line that launches npm is outside run_install, so nothing captures or prints its output:
  ${launches[0].line.trim()}`,
		)

		assert.doesNotMatch(
			launches[0].line,
			SILENT,
			'`npm install` is handed a silent flag again, and that is what suppressed the resolution error this gate exists to report',
		)
	})

	it('adds nothing to npm`s environment or to an npm config file', () => {
		// The spellings the check above cannot see, because they are not on the
		// launch line and not in any argv. Scanned over the whole file, not over
		// the one line that runs npm: an `export npm_config_loglevel=0` at the top
		// of the script silences every install in it, and a `loglevel=0` line
		// written into a `.npmrc` silences the install that reads that file.
		const silencing = silencingLines(LINES)

		assert.equal(
			silencing.length,
			0,
			`npm is handed a way to withhold its own error, so a failed install reports a bare exit code again:\n${silencing
				.map((line) => `  ${line.trim()}`)
				.join('\n')}`,
		)
	})

	it('refuses every way of writing that assignment, whatever the value', () => {
		// The check above says the script contains none of these spellings. This
		// says the scan would have caught each one, because a scan that only
		// knows the literal `silent` reports a clean file for `=0` — measured, on
		// npm 11.17.0, to silence the install just as completely (see
		// NPM_CONFIG_ENV). Every spelling below is spliced into the script and
		// put back through the same scan the assertion above runs.
		//
		// The last four are the ones that reach npm's environment without the
		// token `npm_config_` appearing in the file at all: a shell builds the
		// name out of adjacent quoted fragments, or across a line continuation,
		// and the page never shows the word. Each was spliced as the edit it is —
		// a spelling that spans two lines is spliced as two — and each is missed
		// by a scan that reads the page instead of what bash reads.
		const launchAt = LINES.findIndex((line) => LAUNCHES_INSTALL.test(line))
		assert.notEqual(launchAt, -1, 'the line that launches npm is gone from the script — this test is stale')
		const TOP = 1 // directly under the shebang: the top-of-file export

		const spellings: Array<{ what: string; at: number; mutation: string }> = [
			{ what: 'a value npm cannot name, which is the one measured at zero bytes', at: TOP, mutation: 'export npm_config_loglevel=0' },
			{ what: 'a named value that is not `silent`', at: TOP, mutation: 'export npm_config_loglevel=off' },
			{ what: 'a value built from a variable, which no text scan can read', at: TOP, mutation: 'export npm_config_loglevel=$LEVEL' },
			{ what: 'the variable name in the upper case npm also reads', at: TOP, mutation: 'export NPM_CONFIG_LOGLEVEL=0' },
			{ what: 'the key in the mixed case npm lowercases for itself', at: TOP, mutation: 'export npm_config_logLevel=0' },
			{
				what: 'a `VAR=value` prefix on the launch line, which is not an argv',
				at: launchAt,
				mutation: 'npm_config_loglevel=0 npm install --no-fund --no-audit --no-save /tmp/namzu-probe.tgz',
			},
			{ what: 'the variable name itself built from a variable', at: TOP, mutation: 'export "npm_config_${KEY}=0"' },
			{ what: 'a name assembled and then assigned through it', at: TOP, mutation: 'KEY=npm_config_loglevel; export "$KEY=0"' },
			// Refused as well, and deliberately. A scan reads text; it cannot know
			// that a quoted string is inert, so a mention is not told apart from an
			// assignment. Comments are where these spellings get talked about, and
			// `CODE` is what keeps that prose out of the assertions above.
			{
				what: 'the name mentioned in a quoted string in code rather than assigned to npm',
				at: TOP,
				mutation: 'echo "npm_config_loglevel is the name a silent install sets"',
			},
			{
				what: 'a config file written by name, with a level the scan cannot read',
				at: TOP,
				mutation: 'printf \'loglevel=0\\n\' > "$CONSUMER_DIR/.npmrc"',
			},
			{
				what: 'a config file npm is told to write, which names no file at all',
				at: TOP,
				mutation: 'npm config set loglevel off --location=project',
			},
			{
				what: 'the name spelled as adjacent quoted fragments, which the shell reads as one word',
				at: TOP,
				mutation: 'export "npm_confi""g_lo""glevel=0"',
			},
			// The same splice at the launch SITE, and not as a `VAR=value` prefix on
			// the launch line: a word whose name is built out of quotes is not an
			// assignment to bash at all. `"npm_confi""g_lo""glevel=0" npm install`
			// runs a command literally named `npm_config_loglevel=0` and exits 127
			// with npm never reached — measured — so an edit that wants the level
			// set at the launch has to set it on the line before it. That line is
			// inside `run_install`, which is the one place the executed check reads
			// as well: this spelling fails the scan and the executed install both.
			// The same line one function higher fails the scan and nothing else,
			// which is the hole the row at the top of this list was written for.
			{
				what: 'the same splice on the line before the launch, where npm reads it from the environment',
				at: launchAt,
				mutation: 'export "npm_confi""g_lo""glevel=0"',
			},
			{
				what: 'the `loglevel` word alone, spliced, in the spelling that names no file and carries no `npm_config_`',
				at: TOP,
				mutation: 'npm config set \'logle\'\'vel\' off --location=project',
			},
			// Two continuations rather than one, so that this row proves the join
			// and nothing else: with a single cut, one of the two lines still holds
			// `npm_config_` or `loglevel` whole and the older, page-reading scan
			// caught it anyway. Split twice, no line the page shows contains either
			// pattern — measured, all three below report zero — while bash reads
			// `export npm_config_loglevel=0` and puts the level in npm's
			// environment. Only the fold finds this one.
			{
				what: 'the name split across two line continuations, which bash joins before it reads the line',
				at: TOP,
				mutation: 'export npm_confi\\\ng_logl\\\nevel=0',
			},
		]

		for (const { what, at, mutation } of spellings) {
			const lines = [...LINES]
			// A spelling that spans two lines is spliced as the two lines it is, so
			// the scan meets it as the edit would leave it in the file.
			lines.splice(at, 0, ...mutation.split('\n'))
			const flagged = silencingLines(lines)
			assert.ok(
				flagged.includes(mutation),
				`the scan does not refuse ${what}, so this line silences npm with the guard reporting a clean file:\n  ${mutation}`,
			)
		}

		// The reverse direction, and the reason the exemption above is worth
		// stating: a scan made to read through quotes could as easily be made to
		// read through a comment. The script talks about these spellings in prose,
		// so the spelling is spliced AS a comment here and the scan has to leave
		// it alone — the same spelled-out name, one `#` away from the row above,
		// and the opposite answer.
		const asComment = '# never export "npm_confi""g_lo""glevel=0" — see NPM_CONFIG_ENV'
		const commented = [...LINES]
		commented.splice(TOP, 0, asComment)
		assert.ok(
			!silencingLines(commented).includes(asComment),
			'a comment naming `npm_config_` is read as if it ran, so the prose that documents this ban fails the gate that asserts it',
		)
	})

	it('hands npm the install argv untouched, and prints what npm said', () => {
		const scratch = mkdtempSync(join(tmpdir(), 'namzu-install-argv-'))
		try {
			const bin = join(scratch, 'bin')
			const consumer = join(scratch, 'consumer')
			mkdirSync(bin)
			mkdirSync(consumer)
			writeStubNpm(bin)

			const result = runProbe(
				installProbe(),
				{
					PATH: `${bin}:${process.env.PATH ?? ''}`,
					CONSUMER_DIR: consumer,
					VERSION_SNAPSHOT: '',
				},
				// The script `cd`s into the consumer directory before it installs,
				// so that is where a real npm would look for its config.
				consumer,
			)

			assert.equal(result.status, 17, `run_install exited ${result.status}, not the 17 npm itself exited with`)
			assert.equal(
				result.stdout,
				'',
				'the report went to stdout, where a caller redirecting this script loses the only line saying what happened',
			)
			// npm's own words, beside the step and the argv it was given.
			assert.match(result.stderr, /npm error code ERESOLVE/, 'npm`s error did not reach the reader')
			assert.match(result.stderr, /npm error While resolving/, 'npm`s error did not reach the reader')
			assert.match(result.stderr, /the step under test/, 'the failed install did not name the step it failed in')
			// ...and printed INSIDE the block that frames them. Anywhere in the
			// run's stderr is not enough: the framing is what says which install
			// spoke, and a launch line that stops capturing stderr — `2>/dev/null`
			// — leaves npm's error with no block to appear in and the block
			// claiming npm wrote nothing.
			assert.match(
				result.stderr,
				/---- npm output ----\n(?:  .*\n)*?  npm error code ERESOLVE/,
				`npm\`s error was not printed under the block that names the install it came from:\n${result.stderr}`,
			)

			// The stub refuses an install that is being silenced, so the run
			// reaching npm's own error at all is the statement that nothing on
			// the launch line, in the environment or in a config file was a way
			// to withhold it — the same three questions the two source checks
			// ask, asked of an executed command instead of a line of text.
			assert.doesNotMatch(
				result.stderr,
				new RegExp(STUB_REFUSED),
				`the stub npm refused this install, so npm would have said nothing about it:\n${result.stderr}`,
			)

			const argv = result.stderr.match(/^ {2}argv: (.*)$/m)?.[1] ?? ''
			assert.ok(argv !== '', `the stub npm never ran; stderr was:\n${result.stderr}`)
			assert.match(argv, /\/probe\/namzu-sdk-1\.2\.3\.tgz/, 'the tarball never reached npm')
			assert.doesNotMatch(argv, SILENT, `npm was handed a silent flag:\n  npm ${argv}`)
		} finally {
			rmSync(scratch, { recursive: true, force: true })
		}
	})

	it('and the npm it hands over is one that refuses to be silenced at all', () => {
		// The guard above is only worth what it is worth: the run it reads has
		// to FAIL when the install IS being silenced, or "npm`s error reached
		// the reader" is a fact about a stub that never looked. The same probe
		// is run twice more, each with one leak planted in one of the two places
		// a log level arrives from that is not the launch line — the environment
		// the install inherits, and the config file npm reads from the directory
		// it runs in. Neither may end with npm's error: both must end with the
		// stub saying what it was handed.
		const scratch = mkdtempSync(join(tmpdir(), 'namzu-install-guard-'))
		try {
			const bin = join(scratch, 'bin')
			mkdirSync(bin)
			writeStubNpm(bin)

			const cases: Array<{ what: string; plant: (consumer: string) => NodeJS.ProcessEnv }> = [
				{
					what: 'a log level exported into the environment the install inherits',
					plant: () => ({ npm_config_loglevel: '0' }),
				},
				{
					what: 'a log level written into the config file the install reads',
					plant: (consumer) => {
						writeFileSync(join(consumer, '.npmrc'), 'loglevel=0\n')
						return {}
					},
				},
			]

			for (const { what, plant } of cases) {
				const consumer = mkdtempSync(join(scratch, 'consumer-'))
				const result = runProbe(
					installProbe(),
					{
						PATH: `${bin}:${process.env.PATH ?? ''}`,
						CONSUMER_DIR: consumer,
						VERSION_SNAPSHOT: '',
						...plant(consumer),
					},
					consumer,
				)

				assert.notEqual(result.status, 17, `${what} was not caught: the install ended on npm\`s own error`)
				assert.match(
					result.stderr,
					new RegExp(STUB_REFUSED),
					`${what} did not make the stub npm refuse, so the check above is reading a run that never looked:\n${result.stderr}`,
				)
				assert.match(
					result.stderr,
					new RegExp(`exit ${STUB_REFUSED_STATUS}`),
					`${what} made the stub refuse without failing, so run_install reported a successful install:\n${result.stderr}`,
				)
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true })
		}
	})

	it('reports the step, the line and the command from inside a function', () => {
		const trapLine = SOURCE.match(/^trap on_error ERR$/m)?.[0]
		assert.notEqual(trapLine, undefined, 'the ERR trap is no longer armed at all — this test is stale')

		// `false` inside a function is the case `set -E` exists for: without it
		// the shell dies with a bare exit code and the trap never runs, so a
		// handler replaced by `:` and a version that dropped `-E` both end here.
		const fragment = [
			'set -Eeuo pipefail',
			'CURRENT_STEP="probe step label"',
			shellFunction('on_error'),
			trapLine,
			'failing_inner() {',
			'  false',
			'}',
			'failing_inner',
			'',
		]
		const failingLine = fragment.join('\n').split('\n').indexOf('  false') + 1
		const result = runProbe(fragment.join('\n'))

		assert.notEqual(result.status, 0, 'the failing command did not abort the probe')
		assert.equal(result.stdout, '', 'the report went to stdout, where a caller redirecting this script loses it')
		// `false` writes nothing, so everything below was written by the handler.
		assert.equal(
			result.stderr.match(/^\s+step:\s+(.+)$/m)?.[1]?.trim(),
			'probe step label',
			`the report did not name the step the run was in:\n${result.stderr}`,
		)
		assert.equal(
			Number(result.stderr.match(/^\s+line:\s+(\d+)$/m)?.[1]),
			failingLine,
			`the report did not name the line that failed (line ${failingLine}):\n${result.stderr}`,
		)
		assert.match(
			result.stderr,
			/^\s+command:\s+false$/m,
			`the report did not name the command that failed:\n${result.stderr}`,
		)
	})

	it('labels the step before the first command in it that can fail', () => {
		// `find` over a missing `.changeset` exits 1 with its stderr discarded,
		// so this is the one failure that produces no other output at all — and
		// with the label assigned on the following line it was reported as
		// `step: startup`.
		const label = SOURCE.indexOf('CURRENT_STEP="applying pending changesets to preview the shipping versions"')
		const command = SOURCE.indexOf('PENDING_CHANGESETS=$(find')
		assert.ok(label !== -1 && command !== -1, 'the pending-changesets label or its command is gone — this test is stale')
		assert.ok(label < command, 'the step label is assigned after the command it labels, so an early failure names the wrong step')
	})

	it('has exactly one on_error, the one the trap installs', () => {
		// `trap on_error ERR` proves the handler is installed once. Which
		// `on_error` it installed is a separate fact: bash runs the LAST
		// definition of a function and every check in this file reads the first,
		// so `on_error() { :; }` appended to the end of the file reports nothing
		// at all while `trap on_error ERR`, the handler probe and the line it
		// names all still pass. `shellFunction` refuses a doubled definition too;
		// this is the same property stated where the trap is the subject.
		assert.equal(
			definitionCount('on_error'),
			1,
			`${SCRIPT} defines on_error ${definitionCount('on_error')} times; the shell runs the last definition, and the report every check here asserts is written by the first`,
		)
	})

	it('and counts a second definition however it is written', () => {
		// The two spellings from the review that the old pattern counted as ZERO
		// — so a second `on_error` written either way ran while this file still
		// reported one — plus the subshell body, which bash accepts as well. Each
		// of the first three was run against bash and defined the function.
		const definitions = [
			'if true; then on_error() { :; }; fi',
			'true && on_error() { :; }',
			'on_error() ( : )',
			'  on_error() { :; }',
			'function on_error { :; }',
		]
		for (const definition of definitions) {
			assert.equal(
				definitionCount('on_error', `${CODE}\n${definition}\n`),
				2,
				`a second on_error written as \`${definition}\` is not counted, and bash runs the last definition — the report every check here asserts is written by the first`,
			)
		}

		// ...while a name that merely CONTAINS the one being counted is not a
		// definition of it: the anchor is the character before the name, and a
		// letter or `_` there means another identifier.
		for (const mention of ['myon_error() { :; }', 'non_error() { :; }', 'on_error_handler() { :; }', 'trap on_error ERR']) {
			assert.equal(
				definitionCount('on_error', `${CODE}\n${mention}\n`),
				1,
				`\`${mention}\` is counted as a definition of on_error, so a line that is not one would fail this file`,
			)
		}
	})

	it('leaves the trap armed and inherited for the whole run', () => {
		// The handler test above says nothing about the hundred lines after it,
		// and the pair that undoes it is two lines long: `set +E` stops the trap
		// being inherited by functions, `trap - ERR` removes it outright, and
		// either one returns every failure below it to a bare exit code. Only
		// `cleanup` is allowed to disarm — it runs after the run has already
		// ended and has to report nothing.
		//
		// The spellings in `DISARMS_ERROR_REPORTING` are the measured ones:
		// `trap '' ERR` and `trap -- ERR` are not in the file today, and each
		// was executed by hand with `trap 'echo TRAPFIRED' ERR` armed — the
		// `false` behind it ran with no TRAPFIRED, which is the disarm a check
		// written for `trap - ERR` alone walks past.
		const cleanup = shellFunction('cleanup')
		const cleanupStart = SOURCE.indexOf(cleanup)
		const disarms = LINES.flatMap((line, index) =>
			isComment(line) || !DISARMS_ERROR_REPORTING.test(line) ? [] : [{ at: lineOffset(index), line }],
		)
		assert.ok(disarms.length > 0, 'no disarm was found at all, not even in cleanup — this test is stale')

		for (const disarm of disarms) {
			assert.ok(
				disarm.at > cleanupStart && disarm.at < cleanupStart + cleanup.length,
				`this line turns the shell's error reporting off outside cleanup, so every failure after it goes back to the bare exit code the trap exists to replace:
  ${disarm.line.trim()}`,
			)
		}

		// `-E` is what carries the trap into functions at all; the handler test
		// above runs its own `set -Eeuo pipefail`, so it cannot see this one
		// missing from the script.
		assert.match(SOURCE, /^set -Eeuo pipefail$/m)
	})

	it('and that scan refuses a disarm without refusing a `set` that is not one', () => {
		// The list in `DISARMS_ERROR_REPORTING` makes two claims, and both are
		// checked against bash here rather than described in a comment: every
		// spelling on it really does lose the report, and every `set` spelling
		// off it really does keep it. The second is the one that was wrong — a
		// pattern for `set\s+\+[A-Za-z]` also matches `set +u`, `set +B`,
		// `set +m` and `set +o pipefail`, so the check failed a reader for four
		// lines that disarm nothing and told them their line "turns the shell's
		// error reporting off", which is not true of any of the four.
		const reportSurvives = (line: string) => {
			// The trap is installed the way the script installs it — the handler
			// defined, then `trap on_error ERR` — and the failure is one inside a
			// function that returns 0, so the only thing that can put TRAPFIRED on
			// stderr is the handler, and the failing command is not also a failing
			// command at the top level that would fire the trap by another route.
			const result = runProbe(
				[
					'set -Eeuo pipefail',
					'on_error() { echo TRAPFIRED >&2; }',
					'trap on_error ERR',
					line,
					'failing_inner() {',
					'  false',
					'  return 0',
					'}',
					'failing_inner',
					'',
				].join('\n'),
			)
			return result.stderr.includes('TRAPFIRED')
		}

		const disarming = [
			'set +E',
			'set +Ee',
			'set +o errtrace',
			'shopt -u -o errtrace',
			'trap - ERR',
			'trap ERR',
			'trap -- ERR',
			"trap '' ERR",
			'trap "" ERR',
			'trap - err',
			"trap -- '' ERR",
			'trap - ERR; true',
		]
		const harmless = [
			'set +e',
			'set +o errexit',
			'set +u',
			'set +B',
			'set +m',
			'set +o pipefail',
			'set +o nounset',
			'trap on_error ERR',
			'trap - INT',
			'set -Eeuo pipefail',
		]

		for (const line of disarming) {
			assert.equal(
				reportSurvives(line),
				false,
				`bash still printed the report for \`${line}\`, so it is not a disarm and the scan should not refuse it`,
			)
			assert.ok(
				DISARMS_ERROR_REPORTING.test(line),
				`the scan does not refuse \`${line}\`, which bash was just shown to leave without its ERR report`,
			)
		}

		for (const line of harmless) {
			assert.equal(
				reportSurvives(line),
				true,
				`bash lost the ERR report for \`${line}\`, so the scan is right to refuse it and this list is wrong`,
			)
			assert.ok(
				!DISARMS_ERROR_REPORTING.test(line),
				`the scan refuses \`${line}\` and calls it a line that turns the shell's error reporting off; bash was just shown to keep it,
and the failure a reader gets for that line is untrue:\n  ${line}`,
			)
		}
	})
})

/**
 * The other half of #415: what the shell hands Node.
 *
 * `require('$WORKSPACE_ROOT/packages/sdk/package.json')` is a JavaScript string
 * the shell builds, and a shell path is not always a path Node can open — under
 * Git Bash it is `/c/Users/...`, which a native Node has never heard of. The
 * fix passes the manifest as an argv, which is what these two checks hold in
 * place: the program handed to Node is static, and no module literal is
 * assembled from a shell value.
 */
describe('what the shell hands Node', () => {
	it('never builds a node program out of shell expansion', () => {
		const programs = inlineNodePrograms()
		assert.ok(programs.length > 0, 'no inline node program was found — this test is stale')

		for (const program of programs) {
			assert.doesNotMatch(
				program.body,
				/[$`]/,
				`a \`node ${program.flag}\` program is built by the shell, so whatever it reads is a shell path — including the Windows one Node cannot open:\n${program.body}`,
			)
		}
	})

	it('never splices a shell value into a require() or import literal', () => {
		const literals = moduleLiterals()
		assert.ok(literals.length > 0, 'no module literal was found — this test is stale')

		for (const literal of literals) {
			assert.doesNotMatch(
				literal.body,
				/[$`]/,
				`${literal.quote}${literal.body}${literal.quote} is a module path built from a shell value, which is a path Node cannot open on Git Bash`,
			)
		}
	})
})

/**
 * `cleanup` deletes three directories, and it takes all three names from
 * variables — which makes it the one function here that can delete something
 * that is not this script's to delete.
 *
 * The incident this exists for: a reviewer pulled `cleanup()` into a probe and
 * set `PACK_DIR=/tmp` and `CONSUMER_DIR=/tmp` before sourcing it, so the
 * `rm -rf` that used to be in the caller ran against `/tmp` and removed other
 * people's scratch — some 2180 unrelated entries, other sessions' task output
 * among them — until a 60s timeout stopped it. The script had created its own
 * directories with `mktemp -d -t namzu-pack.XXXXXX` and was not at fault. The
 * shape is still one a reader can repeat, and the cost is not theirs.
 *
 * Every directory named below is created by THIS test with `mkdtempSync` and
 * removed by it. `/tmp` is never a target: a guard test that deletes something
 * to prove it does not delete things would be the defect it guards.
 */
describe('cleanup removes only directories this script created', () => {
	const probe = (tail: string[]) =>
		[
			'set -Eeuo pipefail',
			shellFunction('is_our_temp_dir'),
			shellFunction('remove_temp_dir'),
			shellFunction('restore_versions'),
			shellFunction('cleanup'),
			...tail,
			'',
		].join('\n')

	it('leaves a directory it did not create, and says so', () => {
		const scratch = mkdtempSync(join(tmpdir(), 'namzu-cleanup-'))
		// Two ways of not being ours: a name this script never uses, and a name
		// it does use in a place it never creates one. Both survive, and both
		// hold a file that would be gone if the removal had happened.
		const foreignName = mkdtempSync(join(tmpdir(), 'namzu-elsewhere-'))
		const foreignParent = mkdtempSync(join(scratch, 'namzu-consumer.'))
		try {
			for (const directory of [foreignName, foreignParent]) {
				writeFileSync(join(directory, 'sentinel.txt'), 'this file must survive')
			}

			// `exit 42` under `set -e`: the refusal must not become the status of
			// a run that has already ended.
			const result = runProbe(probe(['trap cleanup EXIT', 'exit 42']), {
				PACK_DIR: foreignName,
				CONSUMER_DIR: foreignParent,
				VERSION_SNAPSHOT: '',
				WORKSPACE_ROOT: scratch,
			})

			assert.equal(result.status, 42, `the refusal changed the exit status to ${result.status}`)
			assert.ok(
				existsSync(join(foreignName, 'sentinel.txt')),
				`cleanup removed ${foreignName}, which this script did not create`,
			)
			assert.ok(
				existsSync(join(foreignParent, 'sentinel.txt')),
				`cleanup removed ${foreignParent}, which is under no temporary root this script uses`,
			)
			assert.match(result.stderr, /NOT removing it/, `the refusal was not reported:\n${result.stderr}`)
			const refusals = result.stderr.split('\n').filter((line) => line.includes('NOT removing it'))
			assert.equal(refusals.length, 2, `expected exactly one refusal per foreign directory:\n${result.stderr}`)
			assert.ok(result.stderr.includes('PACK_DIR='), `the refusal did not name the variable it refused:\n${result.stderr}`)
			assert.ok(result.stderr.includes(foreignName), `the refusal did not name the path it refused:\n${result.stderr}`)
			assert.ok(result.stderr.includes(foreignParent), `the refusal did not name the path it refused:\n${result.stderr}`)
			// `VERSION_SNAPSHOT` is empty until the changesets step creates it,
			// which is the common path: it is nothing to remove, not a refusal.
			assert.ok(
				!result.stderr.includes('VERSION_SNAPSHOT='),
				`the empty VERSION_SNAPSHOT was treated as a path:\n${result.stderr}`,
			)
		} finally {
			rmSync(scratch, { recursive: true, force: true })
			rmSync(foreignName, { recursive: true, force: true })
		}
	})

	it('still removes the three directories mktemp created for it', () => {
		const scratch = mkdtempSync(join(tmpdir(), 'namzu-cleanup-'))
		// Created exactly as the script creates them, under the temporary root
		// `mktemp -d -t` uses: a guard that refused everything would leak these.
		const pack = mkdtempSync(join(tmpdir(), 'namzu-pack.'))
		const consumer = mkdtempSync(join(tmpdir(), 'namzu-consumer.'))
		const snapshot = mkdtempSync(join(tmpdir(), 'namzu-preversion.'))
		try {
			for (const directory of [pack, consumer, snapshot]) {
				writeFileSync(join(directory, 'sentinel.txt'), 'removed with its directory')
			}

			const result = runProbe(probe(['trap cleanup EXIT', 'exit 0']), {
				PACK_DIR: pack,
				CONSUMER_DIR: consumer,
				VERSION_SNAPSHOT: snapshot,
				WORKSPACE_ROOT: scratch,
			})

			assert.equal(result.status, 0, `the probe exited ${result.status}:\n${result.stderr}`)
			assert.doesNotMatch(result.stderr, /NOT removing it/, `a directory this script created was refused:\n${result.stderr}`)
			for (const directory of [pack, consumer, snapshot]) {
				assert.equal(existsSync(directory), false, `${directory} was not removed`)
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true })
			for (const directory of [pack, consumer, snapshot]) rmSync(directory, { recursive: true, force: true })
		}
	})

	it('treats a call with one argument as nothing to remove', () => {
		// `remove_temp_dir` takes the variable`s NAME and its value, and all
		// three call sites pass both. A reader who sources the file and calls it
		// the other way — one argument — is the shape this guard exists for, and
		// `local path="$2"` under `set -u` aborted the EXIT trap with `$2:
		// unbound variable`, skipping every removal after it and replacing the
		// status of the run that had already ended.
		//
		// Nothing in the script is deleted to prove this: the call is made with
		// a literal label and no value, and the assertion is that the run keeps
		// going and says nothing.
		const result = runProbe(probe(['remove_temp_dir PACK_DIR', 'echo SURVIVED', 'exit 0']))

		assert.equal(result.status, 0, `a one-argument call ended the run:\n${result.stderr}`)
		assert.equal(result.stdout, 'SURVIVED\n', 'the one-argument call did not return to the caller')
		assert.equal(result.stderr, '', `a one-argument call reported a removal it had no path for:\n${result.stderr}`)
	})
})

describe('a Windows shell, where the conversion is not available', () => {
	it('refuses loudly instead of handing Node a path it cannot open', () => {
		// `uname` is stubbed and PATH is emptied inside the probe, so this is the
		// MSYS-without-cygpath case whatever the host has installed.
		const fragment = [
			'set -Eeuo pipefail',
			'uname() { echo MINGW64_NT-10.0-19045; }',
			'PATH=""',
			shellFunction('node_path'),
			'converted=$(node_path "/c/Users/runner/repo/packages/sdk/package.json")',
			`printf 'converted:%s\\n' "$converted"`,
			'',
		].join('\n')
		const result = runProbe(fragment)

		assert.notEqual(result.status, 0, 'the probe continued with a path that cannot be converted')
		assert.match(result.stderr, /cygpath/, `the refusal did not name the missing command:\n${result.stderr}`)
		assert.equal(result.stdout, '', `a path that cannot be converted was handed on anyway:\n${result.stdout}`)
	})

	it('is the identity, and silent, everywhere else', () => {
		const fragment = [
			'set -Eeuo pipefail',
			'uname() { echo Linux; }',
			shellFunction('node_path'),
			`printf '%s\\n' "$(node_path /tmp/namzu-probe/packages/sdk/package.json)"`,
			'',
		].join('\n')
		const result = runProbe(fragment)

		assert.equal(result.status, 0, `node_path failed on a shell it is the identity on:\n${result.stderr}`)
		assert.equal(result.stdout.trim(), '/tmp/namzu-probe/packages/sdk/package.json')
		assert.equal(result.stderr, '', `a quiet path was reported on stderr:\n${result.stderr}`)
	})
})

/**
 * The half of the wiring `check-workflow-gate-parity.mjs` does not reach.
 *
 * That check holds a step NAMED `Pre-publish consumer install check` on both
 * paths onto `main`; it compares names, and it never reads a `run:` body. So
 * the command the step runs is held here, for both workflows, because the
 * failure it prevents is silent: a `run:` that names only the gate runs the
 * gate, passes, and reports success for a file nothing executed. `scripts/` has
 * no package of its own, so no `pnpm -r test` can stand in — a workflow that
 * does not name this file is a workflow that does not run it.
 */
describe('the wiring that runs this file in CI', () => {
	const STEP = 'Pre-publish consumer install check'
	const GATE = 'bash .github/scripts/verify-consumer-install.sh'
	const TEST = 'node --import tsx --test scripts/__tests__/verify-consumer-install-snapshot.test.ts'

	/** Everything from the named step's `run:` to the next step at its level. */
	function stepRunBody(workflow: string): string {
		const text = readFileSync(join(REPO_ROOT, '.github', 'workflows', workflow), 'utf8')
		const marker = `- name: ${STEP}`
		const start = text.indexOf(marker)
		assert.notEqual(start, -1, `${workflow} no longer has a step named \`${STEP}\` — this test is stale`)

		// The indentation of the step, so the slice stops at the next step and a
		// neighbouring step's `run:` cannot stand in for this one's.
		const indent = text.slice(text.lastIndexOf('\n', start) + 1, start)
		const rest = text.slice(start + marker.length)
		const next = rest.search(new RegExp(`^${indent}- `, 'm'))
		const block = next === -1 ? rest : rest.slice(0, next)
		const run = block.indexOf('run: |')
		assert.notEqual(run, -1, `the \`${STEP}\` step in ${workflow} has no \`run:\` block — this test is stale`)
		return block.slice(run)
	}

	for (const workflow of ['ci.yml', 'release.yml']) {
		it(`${workflow} runs this file ahead of the gate it proves`, () => {
			const body = stepRunBody(workflow)
			const test = body.indexOf(TEST)
			assert.notEqual(
				test,
				-1,
				`the \`${STEP}\` step in ${workflow} no longer names this file, and no package runs it:\n${body}`,
			)
			const gate = body.indexOf(GATE)
			assert.notEqual(gate, -1, `the \`${STEP}\` step in ${workflow} no longer runs the gate:\n${body}`)
			assert.ok(
				test < gate,
				`the test runs after the gate in ${workflow}: a failing test then stops nothing, and the gate it proves runs against a script nothing checked:\n${body}`,
			)
		})
	}
})

describe('first-release changelog cleanup', () => {
	it('removes only generated changelogs absent from the original package snapshot', () => {
		const scratch = mkdtempSync(join(tmpdir(), 'namzu-first-release-'))
		try {
			const workspace = join(scratch, 'workspace')
			const snapshot = join(scratch, 'snapshot')
			for (const root of [workspace, snapshot]) {
				for (const pkg of ['new-package', 'existing-package']) {
					execFileSync('mkdir', ['-p', join(root, 'packages', pkg)])
					writeFileSync(join(root, 'packages', pkg, 'package.json'), '{}')
				}
			}
			writeFileSync(join(snapshot, 'packages/existing-package/CHANGELOG.md'), 'uncommitted original')
			writeFileSync(join(workspace, 'packages/existing-package/CHANGELOG.md'), 'preview edit')
			writeFileSync(join(workspace, 'packages/new-package/CHANGELOG.md'), 'first release preview')
			writeFileSync(join(workspace, 'packages/new-package/notes.md'), 'keep this')
			// The function itself, brace to brace: a slice to the next
			// definition would silently widen to whatever gets added between them.
			const restore = shellFunction('restore_versions')
			execFileSync('bash', ['-c', `set -euo pipefail\nWORKSPACE_ROOT="$1"\nVERSION_SNAPSHOT="$2"\n${restore}\nrestore_versions`, '_', workspace, snapshot])
			assert.equal(existsSync(join(workspace, 'packages/new-package/CHANGELOG.md')), false)
			assert.equal(readFileSync(join(workspace, 'packages/existing-package/CHANGELOG.md'), 'utf8'), 'uncommitted original')
			assert.equal(readFileSync(join(workspace, 'packages/new-package/notes.md'), 'utf8'), 'keep this')
		} finally {
			rmSync(scratch, { recursive: true, force: true })
		}
	})
})
