import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A signing key never lands in the repository: the tests make ephemeral ones, and the fixed developer
 * keys of the platform's own vectors are public halves only. This looks at what this change tracks.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const MARK = new RegExp(['-----BEGIN', '[A-Z ]*', 'PRIVATE KEY-----'].join(''))

function walk(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name)
		if (e.isDirectory()) walk(p, out)
		else out.push(p)
	}
	return out
}

describe('no private key is tracked', () => {
	it('finds none in the extension platform, its fixtures or the desktop code that reads it', () => {
		const roots = [
			HERE,
			join(HERE, '..', '..', 'commands'),
			join(HERE, '..', '..', '..', '..', 'desktop', 'src', 'shared'),
		]
		const files = roots.filter(existsSync).flatMap((r) => walk(r))
		expect(files.length).toBeGreaterThan(20)
		const offenders = files.filter(
			(f) => MARK.test(readFileSync(f, 'utf8')) || /\.private\.pem$/.test(f),
		)
		expect(offenders).toEqual([])
	})
	it('keeps developer key files out of version control', () => {
		const ignore = readFileSync(join(HERE, '..', '..', '..', '..', '..', '.gitignore'), 'utf8')
		expect(ignore).toMatch(/^dev-keys\/$/m)
		expect(ignore).toMatch(/^\*\.private\.pem$/m)
	})
})
