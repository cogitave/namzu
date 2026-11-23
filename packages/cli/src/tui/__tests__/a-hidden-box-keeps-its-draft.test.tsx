import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { Composer } from '../Composer.js'

const mounted: { unmount: () => void }[] = []

afterEach(() => {
	for (const harness of mounted) harness.unmount()
	mounted.length = 0
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('the message box while the workflow view takes its place', () => {
	it('draws nothing while hidden and shows its draft again when it is back', async () => {
		const harness = render(<Composer history={[]} onSubmit={() => {}} />)
		mounted.push(harness)
		await flush()
		harness.stdin.write('half a thought')
		await flush()
		expect(harness.lastFrame()).toContain('half a thought')

		harness.rerender(<Composer history={[]} onSubmit={() => {}} hidden disabled />)
		await flush()
		expect((harness.lastFrame() ?? '').trim()).toBe('')

		harness.rerender(<Composer history={[]} onSubmit={() => {}} />)
		await flush()
		expect(harness.lastFrame()).toContain('half a thought')
	})
})
