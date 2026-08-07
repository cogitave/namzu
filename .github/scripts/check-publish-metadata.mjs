#!/usr/bin/env node
/**
 * Every publishable package carries the metadata a signed publish needs.
 *
 * The release workflow publishes with provenance, and the registry verifies
 * the attestation against `repository.url` before it accepts the tarball. A
 * package missing that field is rejected with a 422 — but only at publish
 * time, at the end of a release, after every sibling has already gone out.
 * That is exactly what happened to `@namzu/files@0.2.0`: eleven packages
 * published, one 422'd on a field nothing had ever checked, and the version
 * was left tagged and released with nothing on the registry behind it.
 *
 * Nothing verified this because the field is only load-bearing on the one
 * code path that costs the most to retry.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const EXPECTED_REPO = 'https://github.com/cogitave/namzu'

/**
 * A path in a tarball that is test material rather than shipped code.
 *
 * Deliberately broader than the exclusion patterns in any one manifest. The
 * manifests exclude what we knew to name; this recognises what a test looks
 * like, so a new convention that the patterns miss fails here instead of
 * shipping.
 */
const isTestPath = (p) =>
	/(^|\/)__tests__\//.test(p) ||
	/(^|\/)__fixtures__\//.test(p) ||
	/\.test\.[a-z.]+$/.test(p) ||
	/\.proc-test\.[a-z.]+$/.test(p) ||
	/(^|\/)test-setup\./.test(p)

/**
 * What `npm publish` would actually put on the registry.
 *
 * The manifest's `files` array is a claim; this is the artifact. They come
 * apart easily — `files: ["dist"]` reads as "the build output" and means
 * "everything the compiler emitted", which is how `@namzu/cli@2.0.0` and
 * `@namzu/sdk` shipped with 39% and 42% of their files being compiled tests.
 * Checking the config would have agreed with itself and found nothing.
 */
function packedPaths(dir) {
	// Windows needs a shell here and nothing else does.
	//
	// npm is `npm.cmd` on Windows, and since the CVE-2024-27980 mitigation Node
	// refuses to spawn a `.cmd` without one — `execFileSync('npm.cmd', …)`
	// fails with `spawnSync npm.cmd EINVAL`. Under a shell the arguments are
	// concatenated rather than escaped, which also earns a DEP0190, so it is
	// scoped to the platform that requires it instead of applied everywhere.
	// CI runs Linux and takes the no-shell path.
	//
	// The arguments are fixed literals. Anyone adding an interpolated one here
	// has a command injection on Windows rather than a warning, which is why
	// this is a comment and not just a flag.
	//
	// Getting this wrong is silent in the worst way: the first draft of this
	// check caught the spawn error and continued, reporting fourteen packages
	// clean while packing none of them.
	const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
		cwd: dir,
		encoding: 'utf8',
		shell: process.platform === 'win32',
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	return JSON.parse(out)[0].files.map((f) => f.path)
}

/** Every `packages/**\/package.json`, one level deep and under `providers/`. */
function packageDirs() {
	const roots = ['packages']
	const found = []
	while (roots.length > 0) {
		const root = roots.pop()
		for (const entry of readdirSync(root)) {
			const dir = join(root, entry)
			if (entry === 'node_modules' || !statSync(dir).isDirectory()) continue
			try {
				statSync(join(dir, 'package.json'))
				found.push(dir)
			} catch {
				roots.push(dir)
			}
		}
	}
	return found.sort()
}

const problems = []
let checked = 0

for (const dir of packageDirs()) {
	const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
	if (manifest.private === true) continue
	checked++

	const repo = manifest.repository
	const url = typeof repo === 'string' ? repo : (repo?.url ?? '')
	const normalized = url.replace(/^git\+/, '').replace(/\.git$/, '')

	if (!url) {
		problems.push(
			`${manifest.name} (${dir}) has no \`repository\` field. A provenance publish is rejected without it.`,
		)
	} else if (normalized !== EXPECTED_REPO) {
		problems.push(
			`${manifest.name} (${dir}) points \`repository.url\` at ${normalized}, but provenance is attested against ${EXPECTED_REPO}.`,
		)
	}

	// Not required by the registry, but a package page with no link back is
	// the same omission one step less costly, and the same fix.
	for (const field of ['license', 'description']) {
		if (!manifest[field]) problems.push(`${manifest.name} (${dir}) has no \`${field}\`.`)
	}

	// The tarball carries no test material.
	//
	// A pack failure is a FAILURE, never a skip. The first draft of this check
	// caught the error and continued, and reported every package clean while
	// packing none of them — a verification that could not fail is worse than
	// no verification, because it leaves you confident instead of uncertain.
	let packed
	try {
		packed = packedPaths(dir)
	} catch (err) {
		problems.push(
			`${manifest.name} (${dir}) could not be packed, so its contents are unknown: ${err.message.split('\n')[0]}`,
		)
		continue
	}

	const tests = packed.filter(isTestPath)
	if (tests.length > 0) {
		problems.push(
			`${manifest.name} (${dir}) would publish ${tests.length} test file(s), e.g. ${tests[0]}. Add \`!<root>/**/*.test.*\` and the sibling patterns to \`files\`.`,
		)
	}

	// An empty tarball also contains no tests. Assert the entry point survived,
	// so an over-broad exclusion cannot pass this by shipping nothing. Only
	// when the package declares a `main` — `@namzu/evals` has none and exposes
	// `./kernel/*`, and inventing one for it would fail it for lacking a file
	// it never claimed.
	const main = manifest.main?.replace(/^\.\//, '')
	if (main !== undefined && !packed.includes(main)) {
		problems.push(`${manifest.name} (${dir}) would publish without its \`main\` (${main}).`)
	}
}

if (problems.length > 0) {
	console.error('\n✗ publish-metadata gate failed:\n')
	for (const p of problems) console.error(`  - ${p}`)
	console.error(
		`\n${problems.length} problem(s) across ${checked} publishable packages. Fix the manifest; a release that reaches the registry and fails there has already published its siblings.\n`,
	)
	process.exit(1)
}

console.log(`✓ publish-metadata gate passed (${checked} publishable packages)`)
