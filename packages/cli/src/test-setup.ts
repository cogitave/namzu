/**
 * Vitest `setupFiles` entry for `@namzu/cli`.
 *
 * Before LOG-05, every one of `exec`/`drain`/`exec --json`/the TUI forced the
 * SDK logger's level to `silent` via `configureLogger` on its way into a
 * real session, so the CLI's own test suite got a quiet stderr for free —
 * a side effect of the exact bug LOG-05 exists to fix. Now that each entry
 * point installs a REAL sink at a level it resolves from
 * `--verbose`/`--quiet`/`NAMZU_LOG_LEVEL` (`../logging.ts`), a test whose
 * fixture `ctx` omits `logging` falls back to that same resolution — which
 * reads the live environment. Defaulting `NAMZU_LOG_LEVEL` to `silent`
 * here keeps that fallback quiet, matching pre-LOG-05 test output, without
 * touching the dozen-plus test files across this package that build a
 * `ctx` by hand and have never had reason to care what level logging runs
 * at.
 *
 * Only set when unset, so a contributor debugging a specific test with
 * `NAMZU_LOG_LEVEL=debug pnpm test` gets what they asked for.
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, inject } from 'vitest'

import { removeTempDir } from './__fixtures__/temp-dir.js'

// macOS commonly exposes one temporary directory through both `/var/...` and
// `/private/var/...`. The product canonicalizes filesystem authority paths, so
// let fixtures begin from the same spelling rather than turning correct
// containment and freshness checks into path-string failures.
const canonicalTemporaryRoot = realpathSync(tmpdir())
process.env.TMPDIR = canonicalTemporaryRoot
process.env.TMP = canonicalTemporaryRoot
process.env.TEMP = canonicalTemporaryRoot

if (process.env.NAMZU_LOG_LEVEL === undefined) {
	process.env.NAMZU_LOG_LEVEL = 'silent'
}

// Every session-opening command refreshes the Zen catalogue over the network
// in the background. A test that drives one must not reach the public network
// by accident, so the suite starts with the refresh off; the tests about the
// refresh inject their own fetch. Children spawned with this environment
// inherit the setting.
if (process.env.NAMZU_MODEL_CATALOGUE_REFRESH === undefined) {
	process.env.NAMZU_MODEL_CATALOGUE_REFRESH = '0'
}

// For the same reason, computer use starts without cua-driver: on Windows and
// under WSL a session's first initialize() downloads its 27-29 MB archive from
// GitHub. A test that opened a session there reached the network (the DeepSeek
// capability test's fetch stub caught it). Tests about the driver pass their
// own resolver.
if (process.env.NAMZU_CUA_DRIVER === undefined) {
	process.env.NAMZU_CUA_DRIVER = 'off'
}

// Production now routes generated state through NAMZU_HOME. Give every test
// suite an owned application home so a command-level test can never inspect
// or mutate the developer's real sessions merely because it exercises the
// production entry point. Preserve an explicit value for tests that launch
// this suite under a deliberately chosen state root.
if (process.env.NAMZU_HOME === undefined) {
	const ownedHome = mkdtempSync(join(inject('namzuTestHomeRoot'), 'home-'))
	process.env.NAMZU_HOME = ownedHome
	afterAll(() => {
		// Capture ownership: a test may replace NAMZU_HOME with caller-owned state.
		// Vitest runs this setup hook after the suite's own teardown hooks.
		removeTempDir(ownedHome)
		if (process.env.NAMZU_HOME === ownedHome) {
			// biome-ignore lint/performance/noDelete: assigning undefined creates the string "undefined" in process.env.
			delete process.env.NAMZU_HOME
		}
	})
}

// The developer's own application home is never read or written by a test.
// Every suite gets an owned NAMZU_HOME above, but a code path that resolves
// the home from an environment it was HANDED (`{ HOME: … }` without
// NAMZU_HOME) falls back to `~/.namzu` — the real one. Such an access is
// refused here, as if the directory did not exist, and the suite fails
// naming the path, so the leak is fixed rather than silently tolerated.
const realApplicationHome = resolve(homedir(), '.namzu')
const leaks: string[] = []
function underRealHome(target: unknown): string | undefined {
	let text: string | undefined
	if (typeof target === 'string') text = target
	else if (target instanceof URL && target.protocol === 'file:') text = fileURLToPath(target)
	else if (Buffer.isBuffer(target)) text = target.toString()
	if (text === undefined) return undefined
	const absolute = resolve(text)
	return absolute === realApplicationHome || absolute.startsWith(`${realApplicationHome}/`)
		? absolute
		: undefined
}
// `~/.agents/skills` is a skill tier every session reads, so reaching it is
// not a defect — but the developer's own skills must not leak into a test's
// catalog. Refused as absent, silently: a test that wants that tier passes
// its own `home`.
const realAgentsHome = resolve(homedir(), '.agents')
function underRealAgentsHome(target: unknown): string | undefined {
	let text: string | undefined
	if (typeof target === 'string') text = target
	else if (target instanceof URL && target.protocol === 'file:') text = fileURLToPath(target)
	else if (Buffer.isBuffer(target)) text = target.toString()
	if (text === undefined) return undefined
	const absolute = resolve(text)
	return absolute === realAgentsHome || absolute.startsWith(`${realAgentsHome}/`)
		? absolute
		: undefined
}
function refused(path: string, record = true): NodeJS.ErrnoException {
	if (record) leaks.push(path)
	const error: NodeJS.ErrnoException = new Error(
		`ENOENT: a test reached the real application home (${path})`,
	)
	error.code = 'ENOENT'
	return error
}
{
	const fs = createRequire(import.meta.url)('node:fs') as Record<string, unknown> & {
		promises: Record<string, unknown>
	}
	const guard = (
		owner: Record<string, unknown>,
		name: string,
		kind: 'sync' | 'async' | 'exists',
	) => {
		const original = owner[name]
		if (typeof original !== 'function') return
		const wrapped = function (this: unknown, target: unknown, ...rest: unknown[]) {
			const agentsPath = underRealAgentsHome(target)
			const path = underRealHome(target) ?? agentsPath
			if (path !== undefined) {
				const error = refused(path, agentsPath === undefined)
				if (kind === 'exists') return false
				if (kind === 'async') {
					const callback = rest.at(-1)
					if (typeof callback === 'function') {
						queueMicrotask(() => callback(error))
						return undefined
					}
					return Promise.reject(error)
				}
				throw error
			}
			return original.call(this, target, ...rest)
		}
		Object.assign(wrapped, original)
		owner[name] = wrapped
	}
	for (const name of [
		'accessSync',
		'appendFileSync',
		'copyFileSync',
		'lstatSync',
		'mkdirSync',
		'openSync',
		'opendirSync',
		'readFileSync',
		'readdirSync',
		'readlinkSync',
		'realpathSync',
		'renameSync',
		'rmSync',
		'rmdirSync',
		'statSync',
		'unlinkSync',
		'writeFileSync',
		'createReadStream',
		'createWriteStream',
		'watch',
	])
		guard(fs, name, 'sync')
	guard(fs, 'existsSync', 'exists')
	for (const name of [
		'access',
		'appendFile',
		'lstat',
		'mkdir',
		'open',
		'opendir',
		'readFile',
		'readdir',
		'readlink',
		'realpath',
		'rename',
		'rm',
		'rmdir',
		'stat',
		'unlink',
		'writeFile',
	])
		guard(fs, name, 'async')
	for (const name of [
		'access',
		'appendFile',
		'lstat',
		'mkdir',
		'open',
		'opendir',
		'readFile',
		'readdir',
		'readlink',
		'realpath',
		'rename',
		'rm',
		'rmdir',
		'stat',
		'unlink',
		'writeFile',
	])
		guard(fs.promises, name, 'async')
	syncBuiltinESMExports()
}
afterAll(() => {
	if (leaks.length > 0)
		throw new Error(
			`tests reached the real application home ${realApplicationHome}; give the code under test an owned NAMZU_HOME:\n${[...new Set(leaks)].join('\n')}`,
		)
})
