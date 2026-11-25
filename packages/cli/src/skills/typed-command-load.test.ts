import { describe, expect, it, vi } from 'vitest'

import { loadTypedCommand } from './typed-command-load.js'

describe('loading a command the person typed', () => {
	it('asks the expansion hooks before the skill’s hooks attach and before any command runs', async () => {
		const steps: string[] = []
		const loaded = await loadTypedCommand({
			expansion: async () => {
				steps.push('expansion')
				return {}
			},
			attachHooks: () => {
				steps.push('attach')
				return { remove: () => steps.push('remove') }
			},
			expand: async () => {
				steps.push('commands')
				return 'text'
			},
		})
		expect(loaded).toEqual({ kind: 'loaded', text: 'text' })
		expect(steps).toEqual(['expansion', 'attach', 'commands'])
	})

	it('runs nothing and attaches nothing when a hook blocks the expansion', async () => {
		const attach = vi.fn()
		const expand = vi.fn()
		const loaded = await loadTypedCommand({
			expansion: async () => ({ blocked: 'not today' }),
			attachHooks: attach,
			expand,
		})
		expect(loaded).toEqual({ kind: 'blocked', reason: 'not today' })
		expect(attach).not.toHaveBeenCalled()
		expect(expand).not.toHaveBeenCalled()
	})

	it('takes the skill’s hooks off again when a command fails the load', async () => {
		const remove = vi.fn()
		const loaded = await loadTypedCommand({
			attachHooks: () => ({ remove }),
			expand: async () => {
				throw new Error('refused')
			},
		})
		expect(loaded).toMatchObject({ kind: 'failed' })
		expect(remove).toHaveBeenCalledTimes(1)
	})

	it('carries what the expansion hooks said beside the prompt', async () => {
		const loaded = await loadTypedCommand({ expansion: async () => ({ context: 'note' }) })
		expect(loaded).toEqual({ kind: 'loaded', context: 'note' })
	})

	it('goes on when the expansion hooks cannot answer', async () => {
		const loaded = await loadTypedCommand({
			expansion: async () => {
				throw new Error('gone')
			},
			expand: async () => 'text',
		})
		expect(loaded).toEqual({ kind: 'loaded', text: 'text' })
	})
})
