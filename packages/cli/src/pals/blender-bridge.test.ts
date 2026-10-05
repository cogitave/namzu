import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('keeps ambiguous Blender work fenced and disabled telemetry independent of private config', () => {
	const result = spawnSync(
		process.platform === 'win32' ? 'python' : 'python3',
		[
			fileURLToPath(new URL('./__fixtures__/blender-bridge-test.py', import.meta.url)),
			fileURLToPath(new URL('../../assets/pal-blender-mcp.py', import.meta.url)),
		],
		{ encoding: 'utf8' },
	)
	expect(result.error).toBeUndefined()
	expect(result.status, result.stderr).toBe(0)
	expect(result.stderr).toContain('Ran 7 tests')
})
