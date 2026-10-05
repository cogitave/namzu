import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { TurnRecovery } from './turn-recovery.js'

it('offers Retry only for a host-supplied target and callable capability', () => {
	const retry = { turnId: 'turn', checkpointId: 'checkpoint' }
	const render = (props: Parameters<typeof TurnRecovery>[0]) =>
		renderToStaticMarkup(createElement(TurnRecovery, props))
	expect(render({ notice: 'Usage remains uncertain.' })).not.toContain('Retry turn')
	expect(render({ retry })).toBe('')
	expect(render({ onRetry: () => {} })).toBe('')
	expect(render({ retry, onRetry: () => {} })).toContain('Retry turn')
	expect(render({ retry, disabled: true, onRetry: () => {} })).toContain('disabled=""')
	expect(render({ notice: 'Usage remains uncertain.' })).toContain('Usage remains uncertain.')
})
