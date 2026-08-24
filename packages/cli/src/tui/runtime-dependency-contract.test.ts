/**
 * The renderer versions are part of the packaged TUI's runtime contract.
 *
 * Workspace tests resolve from pnpm-lock.yaml, but a global npm install resolves
 * the ranges written in package.json again. A newer compatible-looking Ink
 * release paired with a newer React patch made the OAuth picker compute an
 * effectively unbounded root height and allocate millions of terminal rows.
 * Pin the exact pair exercised by the real PTY suite so a published install and
 * this checkout execute the same renderer.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

interface CliManifest {
	readonly dependencies?: Readonly<Record<string, string>>
}

describe('the packaged TUI renderer', () => {
	it('ships the exact renderer pair exercised by this workspace', () => {
		const manifest = JSON.parse(
			readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
		) as CliManifest

		expect(manifest.dependencies?.ink).toBe('7.0.3')
		expect(manifest.dependencies?.react).toBe('19.2.6')
	})
})
