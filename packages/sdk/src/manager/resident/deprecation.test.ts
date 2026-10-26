import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', '..')
const publicFiles = ['public-runtime.ts', 'public-types.ts', 'public-tools.ts']

/** Every file that declares a resident-prefixed public symbol. */
const declaringFiles = [
	...readdirSync(here)
		.filter((f) => f.endsWith('.ts') && !/\.(test|proc-test)\.ts$/.test(f))
		.map((f) => join(here, f)),
	join(src, 'prompt', 'resident-step.ts'),
	join(src, 'prompt', 'resident-learning.ts'),
	join(src, 'tools', 'resident-history.ts'),
	join(src, 'tools', 'resident-tool-evidence.ts'),
]

describe('the resident surface is deprecated', () => {
	it('marks every public resident declaration @deprecated and says what replaces it', () => {
		const exported = new Set(
			publicFiles.flatMap((f) =>
				[...readFileSync(join(src, f), 'utf8').matchAll(/\b(\w*Resident\w*)\b/g)].map((m) => m[1]),
			),
		)
		const decl =
			/^export (?:declare )?(?:abstract )?(?:async )?(?:function|class|const|interface|type|enum) (\w+)/
		const missing: string[] = []
		let checked = 0
		for (const file of declaringFiles) {
			const lines = readFileSync(file, 'utf8').split('\n')
			lines.forEach((line, i) => {
				const name = decl.exec(line)?.[1]
				if (!name || !exported.has(name) || !/resident/i.test(name)) return
				checked++
				let start = i - 1
				while (start >= 0 && !(lines[start] ?? '').includes('/**')) start--
				const doc =
					i > 0 && (lines[i - 1] ?? '').trim().endsWith('*/')
						? lines.slice(start, i).join('\n')
						: ''
				if (!doc.includes('@deprecated') || !doc.includes('next major release')) missing.push(name)
			})
		}
		expect(checked).toBeGreaterThan(80)
		expect(missing).toEqual([])
	})
})
