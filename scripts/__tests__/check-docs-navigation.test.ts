import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { checkDocsNavigation } from '../../tools/docs-navigation.mjs'

const roots: string[] = []

function fixture(pages: string[], concepts = ['alpha']): string {
	const root = mkdtempSync(join(tmpdir(), 'namzu-doc-navigation-'))
	roots.push(root)
	const directory = join(root, 'docs', 'packages')
	mkdirSync(directory, { recursive: true })
	writeFileSync(join(directory, 'meta.json'), `${JSON.stringify({ pages })}\n`)
	for (const concept of concepts) writeFileSync(join(directory, `${concept}.md`), `# ${concept}\n`)
	return root
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe('checkDocsNavigation', () => {
	test('accepts a listed sibling concept page', () => {
		assert.deepEqual(checkDocsNavigation(fixture(['alpha'])), [])
	})

	test('accepts a navigation section separator', () => {
		assert.deepEqual(checkDocsNavigation(fixture(['---Reference---', 'alpha'])), [])
	})

	test('rejects an unlisted sibling concept page', () => {
		assert.deepEqual(checkDocsNavigation(fixture([])), [
			'NAVIGATION docs/packages/meta.json: omits sibling concept page alpha.md',
		])
	})

	test('rejects a duplicate navigation entry', () => {
		assert.deepEqual(checkDocsNavigation(fixture(['alpha', 'alpha'])), [
			'NAVIGATION docs/packages/meta.json: pages contains a duplicate entry',
		])
	})

	test('rejects a navigation entry with no page or child directory', () => {
		assert.deepEqual(checkDocsNavigation(fixture(['alpha', 'missing'])), [
			'NAVIGATION docs/packages/meta.json: page entry missing does not resolve',
		])
	})
})
