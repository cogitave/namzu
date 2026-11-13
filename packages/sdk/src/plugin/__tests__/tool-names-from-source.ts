import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Every tool name the SDK defines, read from the source: each `defineTool({`
 * call and the `name` it gives (a literal, or a constant defined in the SDK).
 * The documentation's list of tool names is checked against this, so the page
 * cannot drift from the code. A name that cannot be resolved throws, so a new
 * way of naming a tool is noticed, not skipped.
 */
export function toolNamesFromSource(): string[] {
	const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
	const files: string[] = []
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry)
			if (statSync(path).isDirectory()) {
				if (entry !== '__tests__' && entry !== 'node_modules') walk(path)
			} else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) files.push(path)
		}
	}
	walk(root)
	const constants = new Map<string, string>()
	for (const file of files) {
		for (const match of readFileSync(file, 'utf8').matchAll(
			/(?:const|let)\s+([A-Z][A-Z0-9_]+)(?::\s*string)?\s*=\s*'([^']+)'/g,
		)) {
			constants.set(match[1] as string, match[2] as string)
		}
	}
	const names = new Set<string>()
	for (const file of files) {
		const source = readFileSync(file, 'utf8')
		for (const call of source.matchAll(/defineTool(?:<[^>]*>)?\(\{/g)) {
			const window = source.slice(call.index, (call.index ?? 0) + 600)
			const named = /\bname:\s*(?:'([^']+)'|([A-Z][A-Z0-9_]+))/.exec(window)
			const value = named?.[1] ?? (named?.[2] ? constants.get(named[2]) : undefined)
			if (value === undefined) {
				throw new Error(`cannot read the tool name of a defineTool call in ${file}`)
			}
			names.add(value)
		}
	}
	return [...names].sort()
}
