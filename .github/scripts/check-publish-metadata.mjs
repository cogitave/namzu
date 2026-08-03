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

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const EXPECTED_REPO = 'https://github.com/cogitave/namzu'

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
