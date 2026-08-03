import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ClawtoolBinaryError, findBinary } from './binary.js'

/**
 * POSIX file modes do not exist on Windows: `chmod` is a no-op there and
 * `fs.stat().mode` reports a fixed value, so these cases assert a
 * permission the platform cannot enforce. Skipping keeps the suite
 * meaningful on Windows instead of permanently red — the behavior itself
 * is still covered on Linux and macOS, where it actually matters.
 */
const IS_WINDOWS = process.platform === 'win32'

function execBin(dir: string, name: string): string {
	const path = join(dir, name)
	writeFileSync(path, '#!/bin/sh\nexit 0\n')
	chmodSync(path, 0o755)
	return path
}

describe('findBinary', () => {
	it('returns the override when it is executable', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-bin-'))
		const path = execBin(dir, 'clawtool')
		expect(findBinary({ override: path })).toBe(path)
	})

	it.skipIf(IS_WINDOWS)('throws when the override is not executable', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-bin-'))
		const path = join(dir, 'clawtool')
		writeFileSync(path, '#!/bin/sh\nexit 0\n')
		// no chmod +x
		expect(() => findBinary({ override: path })).toThrow(ClawtoolBinaryError)
	})

	it('finds an executable in the provided PATH', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-bin-'))
		const path = execBin(dir, 'clawtool')
		const otherDir = mkdtempSync(join(tmpdir(), 'namzu-bin-other-'))
		const result = findBinary({ path: [otherDir, dir].join(delimiter) })
		expect(result).toBe(path)
	})

	it('throws an actionable error when the binary is nowhere on PATH', () => {
		const otherDir = mkdtempSync(join(tmpdir(), 'namzu-bin-other-'))
		expect(() => findBinary({ path: otherDir })).toThrowError(/clawtool binary not found/)
	})

	it('respects a custom binary name override', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-bin-'))
		const path = execBin(dir, 'clawtool-dev')
		expect(findBinary({ path: dir, name: 'clawtool-dev' })).toBe(path)
	})
})
