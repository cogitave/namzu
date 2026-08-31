import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

function* filesNamedUnder(directory, name) {
	if (!existsSync(directory)) return
	const entries = readdirSync(directory, { withFileTypes: true })
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const path = join(directory, entry.name)
		if (entry.isDirectory()) yield* filesNamedUnder(path, name)
		else if (entry.name === name) yield path
	}
}

const relativeTo = (root, path) => relative(root, path).split('\\').join('/')

/**
 * Validate every docs navigation manifest without reading concept content.
 * Returning messages instead of exiting keeps the rule mutation-testable.
 */
export function checkDocsNavigation(root) {
	const problems = []
	for (const metaPath of filesNamedUnder(join(root, 'docs'), 'meta.json')) {
		const where = relativeTo(root, metaPath)
		let navigation
		try {
			navigation = JSON.parse(readFileSync(metaPath, 'utf8'))
		} catch (error) {
			problems.push(
				`NAVIGATION ${where}: invalid JSON (${error instanceof Error ? error.message : error})`,
			)
			continue
		}
		if (
			!navigation ||
			typeof navigation !== 'object' ||
			!Array.isArray(navigation.pages) ||
			navigation.pages.some((page) => typeof page !== 'string')
		) {
			problems.push(`NAVIGATION ${where}: pages must be an array of strings`)
			continue
		}

		const pages = navigation.pages
		const uniquePages = new Set(pages)
		if (uniquePages.size !== pages.length) {
			problems.push(`NAVIGATION ${where}: pages contains a duplicate entry`)
		}

		const directory = dirname(metaPath)
		const siblings = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
			left.name.localeCompare(right.name),
		)
		for (const entry of siblings) {
			if (!entry.isFile() || !entry.name.endsWith('.md')) continue
			const slug = entry.name.slice(0, -3)
			if (slug === 'README' || slug === 'index' || slug === 'log') continue
			if (!uniquePages.has(slug)) {
				problems.push(`NAVIGATION ${where}: omits sibling concept page ${slug}.md`)
			}
		}

		for (const page of pages) {
			if (/^---.*---$/.test(page)) continue
			const resolves =
				(page === 'index' &&
					(existsSync(join(directory, 'README.md')) || existsSync(join(directory, 'index.md')))) ||
				existsSync(join(directory, `${page}.md`)) ||
				existsSync(join(directory, page))
			if (!resolves) problems.push(`NAVIGATION ${where}: page entry ${page} does not resolve`)
		}
	}
	return problems
}
