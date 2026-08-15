import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKIP_DIRS = new Set(['__tests__'])
const SILENCE_PATTERN = /configureLogger\(\s*\{\s*level:\s*['"]silent['"]/

function collectSourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry)
		const stat = statSync(full)
		if (stat.isDirectory()) {
			if (SKIP_DIRS.has(entry)) continue
			collectSourceFiles(full, out)
			continue
		}
		if (/\.(tsx?|jsx?)$/.test(entry) && !/\.test\.[jt]sx?$/.test(entry)) {
			out.push(full)
		}
	}
	return out
}

describe('the CLI no longer silences its own logger', () => {
	it('has zero configureLogger silencing call sites outside __tests__', () => {
		const offenders = collectSourceFiles(SRC_ROOT).filter((file) =>
			SILENCE_PATTERN.test(readFileSync(file, 'utf8')),
		)
		expect(offenders).toEqual([])
	})
})
