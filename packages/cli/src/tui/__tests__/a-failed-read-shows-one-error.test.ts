import { describe, expect, it } from 'vitest'
import { toolFailureText } from '../tool-failure-text.js'

describe('a failed read draws its message once', () => {
	it('carries no second generic error after the tool message', () => {
		const said =
			'This file is not readable as text (14 B of binary or non-UTF-8 data). Inspect it with a shell command such as file or xxd.'
		const text = toolFailureText(said, false)
		expect(text).toBe(`Error: ${said}`)
		expect(text.match(/Error:/g)).toHaveLength(1)
		expect(text).not.toContain('Tool execution failed')
	})
})
