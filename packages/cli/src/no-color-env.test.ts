import { describe, expect, it } from 'vitest'

import { applyNoColor } from './no-color-env.js'

describe('NO_COLOR reaches the renderer as FORCE_COLOR=0', () => {
	it('is set when NO_COLOR is on its own', () => {
		const env: NodeJS.ProcessEnv = { NO_COLOR: '1', TERM: 'xterm-256color' }
		applyNoColor(env)
		expect(env.FORCE_COLOR).toBe('0')
	})
	it('leaves an explicit FORCE_COLOR alone', () => {
		const env: NodeJS.ProcessEnv = { NO_COLOR: '1', FORCE_COLOR: '3' }
		applyNoColor(env)
		expect(env.FORCE_COLOR).toBe('3')
	})
	it('does nothing without NO_COLOR, or with it empty (the convention counts only a non-empty value)', () => {
		const plain: NodeJS.ProcessEnv = {}
		applyNoColor(plain)
		expect(plain.FORCE_COLOR).toBeUndefined()
		const empty: NodeJS.ProcessEnv = { NO_COLOR: '' }
		applyNoColor(empty)
		expect(empty.FORCE_COLOR).toBeUndefined()
	})
})
