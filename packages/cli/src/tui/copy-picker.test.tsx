import { render } from 'ink-testing-library'
import { expect, it } from 'vitest'

import { CopyPicker } from './CopyPicker.js'

it('renders bounded source previews through the terminal-safe projection', () => {
	const source = `safe\u0007\u009b\u202etext\nsecond line`
	const targets = [
		{ kind: 'whole' as const, label: 'Whole response' as const, text: 'whole' },
		{ kind: 'code' as const, label: `js\u202e code`, text: source },
	]
	const original = structuredClone(targets)
	const harness = render(<CopyPicker targets={targets} selected={1} />)
	const frame = harness.lastFrame() ?? ''

	expect(frame).toContain('Copy from response')
	expect(frame).toContain('2/2')
	expect(frame).toContain('js\\u{202e} code')
	expect(frame).toContain('safe\\u{0007}\\u{009b}\\u{202e}text')
	expect(frame).not.toContain('\u0007')
	expect(frame).not.toContain('\u009b')
	expect(frame).not.toContain('\u202e')
	expect(targets).toEqual(original)

	harness.unmount()
})
