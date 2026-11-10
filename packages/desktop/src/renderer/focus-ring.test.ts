import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = new URL('.', import.meta.url).pathname

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name)
		return statSync(path).isDirectory() ? walk(path) : [path]
	})
}

const sources = walk(root).filter((p) => /\.(css|tsx)$/.test(p) && !p.endsWith('theme.css'))

describe('one focus ring', () => {
	it('theme defines the ring as a token', () => {
		const theme = readFileSync(join(root, 'theme.css'), 'utf8')
		expect(theme).toMatch(/--focus-ring:/)
	})

	it('no focus-visible rule draws its own coloured outline', () => {
		const offenders: string[] = []
		for (const path of sources.filter((p) => p.endsWith('.css'))) {
			const css = readFileSync(path, 'utf8')
			for (const rule of css.matchAll(/([^{}]*:focus-visible[^{}]*)\{([^{}]*)\}/g)) {
				if (/outline:\s*\d+px solid (?!transparent)/.test(rule[2] ?? '')) {
					offenders.push(`${path}: ${rule[1]?.trim()}`)
				}
			}
		}
		expect(offenders).toEqual([])
	})

	it('components do not use Tailwind ring utilities for focus', () => {
		const offenders = sources
			.filter((p) => p.endsWith('.tsx'))
			.filter((p) =>
				/(?:focus|focus-visible):(?:ring-(?:2|\[3px\])|outline-ring)/.test(readFileSync(p, 'utf8')),
			)
		expect(offenders).toEqual([])
	})
})
