import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ClawtoolBinaryError, findBinary } from './binary.js'

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

	it('throws when the override is not executable', () => {
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
