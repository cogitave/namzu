import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GlobTooComplexError, MAX_GLOB_SEGMENT_LENGTH, compileSegment } from '../glob-segment.js'

// The generator lives with the repository scripts; the path is computed so this
// package does not take a compile-time dependency on a file outside it.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
const generator = pathToFileURL(join(ROOT, 'scripts', 'generate-conformance-vectors.mjs')).href

describe('glob segment conformance vectors', () => {
	it('match what the compiler produces, so a behaviour change regenerates them', async () => {
		const mod = (await import(/* @vite-ignore */ generator)) as {
			GLOB_SEGMENT_VECTORS_PATH: string
			buildGlobSegmentVectors: (api: {
				compileSegment: typeof compileSegment
				GlobTooComplexError: typeof GlobTooComplexError
				MAX_GLOB_SEGMENT_LENGTH: number
			}) => string
		}
		const expected = mod.buildGlobSegmentVectors({
			compileSegment,
			GlobTooComplexError,
			MAX_GLOB_SEGMENT_LENGTH,
		})
		const onDisk = readFileSync(mod.GLOB_SEGMENT_VECTORS_PATH, 'utf8')
		// Compared as parsed data first, so a failure names a case instead of printing 500 KB.
		expect(JSON.parse(onDisk)).toEqual(JSON.parse(expected))
		expect(onDisk).toBe(expected)
	})
})
