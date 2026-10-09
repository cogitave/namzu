import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import { liveRenderOption } from '../render-mode.js'

describe('liveRenderOption', () => {
	it('forces live drawing on a real terminal', () => {
		expect(liveRenderOption({ isTTY: true }, { isTTY: true }, false)).toEqual({ interactive: true })
	})
	it('accepts the Windows console reader as the input', () => {
		expect(liveRenderOption({ isTTY: true }, {}, true)).toEqual({ interactive: true })
	})
	it('leaves Ink to decide when stdout or the input is not a terminal', () => {
		expect(liveRenderOption({}, { isTTY: true }, false)).toEqual({})
		expect(liveRenderOption({ isTTY: true }, {}, false)).toEqual({})
	})
	it('does not change the environment that child processes see', () => {
		const before = process.env.CI
		liveRenderOption({ isTTY: true }, { isTTY: true }, false)
		expect(process.env.CI).toBe(before)
		const child = spawnSync(
			process.execPath,
			['-e', 'process.stdout.write(process.env.CI ?? "")'],
			{
				env: { ...process.env, CI: 'true' },
				encoding: 'utf8',
			},
		)
		expect(child.stdout).toBe('true')
	})
})
