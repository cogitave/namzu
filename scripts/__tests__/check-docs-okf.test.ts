/**
 * The OKF gate must fail on each of the three things the spec's §11 calls
 * non-conformant, and on nothing else — a page with only `type` is whole.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'

// @ts-expect-error a plain module without a declaration file
import { checkBundle } from '../../tools/check-docs-okf.mjs'

function bundle(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'okf-'))
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(join(root, name, '..'), { recursive: true })
		writeFileSync(join(root, name), content)
	}
	return root
}

const ROOT_INDEX = '---\nokf_version: "0.2"\n---\n\n# Bundle\n'

test('a concept carrying only type is conformant', () => {
	const root = bundle({ 'index.md': ROOT_INDEX, 'a.md': '---\ntype: Guide\n---\nbody\n', 'log.md': '# Log\n' })
	try {
		assert.deepEqual(checkBundle(root), { errors: [], files: 3 })
	} finally {
		rmSync(root, { recursive: true })
	}
})

test('a concept without frontmatter, or without type, fails', () => {
	const root = bundle({ 'index.md': ROOT_INDEX, 'bare.md': '# no frontmatter\n', 'untyped.md': '---\ntitle: x\n---\n' })
	try {
		const { errors } = checkBundle(root)
		assert.equal(errors.length, 2)
		assert.match(errors[0] ?? '', /bare\.md: missing or unterminated/)
		assert.match(errors[1] ?? '', /untyped\.md: .*type/)
	} finally {
		rmSync(root, { recursive: true })
	}
})

test('the root index declares only okf_version; a nested index and a log carry none', () => {
	const root = bundle({
		'index.md': '---\nokf_version: "0.2"\ntitle: extra\n---\n',
		'sub/index.md': '---\ntype: Index\n---\n',
		'sub/log.md': '---\ntype: Log\n---\n',
	})
	try {
		const { errors } = checkBundle(root)
		assert.deepEqual(
			errors.map((e) => e.split(':')[0]),
			['index.md', 'sub/index.md', 'sub/log.md'],
		)
	} finally {
		rmSync(root, { recursive: true })
	}
})

test('a root index without okf_version fails', () => {
	const root = bundle({ 'index.md': '# Bundle\n' })
	try {
		assert.match(checkBundle(root).errors[0] ?? '', /okf_version/)
	} finally {
		rmSync(root, { recursive: true })
	}
})
