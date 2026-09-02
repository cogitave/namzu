// The documentation gate: `docs/` is an OKF v0.2 knowledge bundle.
//
// The spec (https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
// makes conformance small on purpose, and this gate checks exactly that
// and nothing more (§11):
//
//   - every non-reserved `.md` file carries parseable YAML frontmatter with
//     a non-empty `type`;
//   - the bundle-root `index.md` carries only `okf_version: "0.2"`; a nested
//     `index.md` carries no frontmatter at all (§8, §12);
//   - `log.md` carries no frontmatter (§9).
//
// Everything else the spec names — `generated`, `verified`, `status`,
// `sources`, `stale_after` — is optional, and its absence is a signal a
// consumer reads, not a defect this gate reports. The previous gate had
// nine required keys and a git-history drift check; both trained readers to
// wave failures through, which is the one thing a gate must not do.
//
// Usage: node tools/check-docs-okf.mjs [bundleDir]

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(import.meta.url)

const RESERVED = new Set(['index.md', 'log.md'])
const OKF_VERSION = /^okf_version:\s*["']?0\.2["']?\s*$/

export function frontmatter(document) {
	const lines = document.split(/\r?\n/)
	if (lines[0] !== '---') return null
	const end = lines.indexOf('---', 1)
	if (end < 0) return null
	return lines.slice(1, end)
}

export function checkConcept(path, document) {
	const fm = frontmatter(document)
	if (fm === null) return [`${path}: missing or unterminated YAML frontmatter`]
	if (!fm.some((line) => /^type:\s*\S/.test(line))) {
		return [`${path}: frontmatter must contain a non-empty type field`]
	}
	return []
}

export function checkIndex(path, document, isRoot) {
	const fm = frontmatter(document)
	if (isRoot) {
		if (fm === null || !fm.some((line) => OKF_VERSION.test(line))) {
			return [`${path}: bundle-root index must declare okf_version 0.2`]
		}
		if (fm.filter((line) => line.trim()).length !== 1) {
			return [`${path}: index frontmatter may contain only okf_version`]
		}
	} else if (fm !== null) {
		return [`${path}: nested index files must not contain frontmatter`]
	}
	return []
}

export function checkLog(path, document) {
	return frontmatter(document) === null ? [] : [`${path}: log files must not contain frontmatter`]
}

export function checkBundle(root) {
	const errors = []
	let files = 0
	const walk = (dir) => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name)
			if (statSync(path).isDirectory()) {
				walk(path)
				continue
			}
			if (!name.endsWith('.md')) continue
			files += 1
			const document = readFileSync(path, 'utf8')
			const shown = relative(root, path)
			if (name === 'index.md') errors.push(...checkIndex(shown, document, dir === root))
			else if (name === 'log.md') errors.push(...checkLog(shown, document))
			else if (!RESERVED.has(name)) errors.push(...checkConcept(shown, document))
		}
	}
	walk(root)
	return { errors, files }
}

if (process.argv[1] && resolve(process.argv[1]) === here) {
	const root = resolve(process.argv[2] ?? join(dirname(here), '..', 'docs'))
	const { errors, files } = checkBundle(root)
	if (errors.length) {
		console.error(`OKF gate: ${errors.length} problem(s) across ${files} file(s) under ${root}`)
		for (const error of errors) console.error(`  ${error}`)
		process.exit(1)
	}
	console.log(`OKF v0.2 gate passed: ${files} file(s) under ${relative(process.cwd(), root) || '.'}`)
}
