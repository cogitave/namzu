/** Ordinary conversation keeps accounting out of the footer; /cost owns it. */

import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { StatusBar } from '../StatusBar.js'

function frame(hint?: string): string {
	const harness = render(
		<StatusBar cwd="/work/project" provider="provider" model="model" state="thinking" hint={hint} />,
	)
	const result = harness.lastFrame() ?? ''
	harness.unmount()
	return result
}

describe('the quiet status bar', () => {
	it('contains identity and location without ambient token, context, or price telemetry', () => {
		const output = frame()
		expect(output).toContain('model')
		expect(output).toContain('/work/project')
		expect(output).not.toMatch(/\bctx\b/iu)
		expect(output).not.toMatch(/\btok\b/iu)
		expect(output).not.toContain('$')
	})

	it('shows an actionable contextual hint when App supplies one', () => {
		expect(frame('enter steer · tab queue · esc interrupt')).toContain(
			'enter steer · tab queue · esc interrupt',
		)
	})
})
