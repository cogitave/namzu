import { expect, it } from 'vitest'
import { resolveComposerSendOptions } from './composer-send-options.js'

it('defaults owned Pal drafts and effort-only settings to automatic guest tool approval', () => {
	expect(resolveComposerSendOptions(undefined, 'owned-pal')).toEqual({ permissionMode: 'auto' })
	expect(resolveComposerSendOptions({ effort: 'high' }, 'owned-pal')).toEqual({
		effort: 'high',
		permissionMode: 'auto',
	})
})

it('retains asking for ordinary conversations and every explicit operator mode', () => {
	expect(resolveComposerSendOptions(undefined)).toEqual({ permissionMode: 'prompt' })
	expect(resolveComposerSendOptions({ effort: 'low' })).toEqual({
		effort: 'low',
		permissionMode: 'prompt',
	})
	for (const permissionMode of ['prompt', 'accept-edits', 'auto', 'strict', 'plan'] as const)
		expect(resolveComposerSendOptions({ permissionMode }, 'owned-pal')).toEqual({ permissionMode })
})

it('carries the effort panel’s hypermode choice, on or off, and nothing when it was not chosen', () => {
	expect(resolveComposerSendOptions({ effort: 'high', hypermode: true })).toEqual({
		effort: 'high',
		hypermode: true,
		permissionMode: 'prompt',
	})
	expect(resolveComposerSendOptions({ hypermode: false })).toEqual({
		hypermode: false,
		permissionMode: 'prompt',
	})
	expect(resolveComposerSendOptions({ effort: 'low' })).not.toHaveProperty('hypermode')
})
