import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { Composer } from '../Composer.js'

const mounted: { unmount: () => void }[] = []

afterEach(() => {
	for (const harness of mounted) harness.unmount()
	mounted.length = 0
})

function open(props: Partial<Parameters<typeof Composer>[0]>) {
	const harness = render(<Composer history={[]} onSubmit={() => {}} {...props} />)
	mounted.push(harness)
	return harness
}

describe('the message box while a panel above it has the keyboard', () => {
	it('is a bare ellipsis when it is only disabled', () => {
		const frame = open({ disabled: true }).lastFrame() ?? ''
		expect(frame).toContain('…')
		expect(frame).not.toContain('Type a message')
	})

	it('keeps its prompt and hint when it is parked under the workflow view', () => {
		const frame = open({ disabled: true, parked: true }).lastFrame() ?? ''
		expect(frame).toContain('❯')
		expect(frame).toContain('Type a message')
	})
})
