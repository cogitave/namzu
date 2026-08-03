import { describe, expect, it } from 'vitest'

import { ToolGrantSet, toolGrantKeys } from '../tool-grants.js'

/**
 * An approval was recorded nowhere: approving emitted an event and settled,
 * with no set, map or store written. `bash` is unconditionally non-read-only
 * and in no allowlist, so `bash: git status` re-prompted on every batch
 * forever — and the only escape was a blanket session grant that also
 * covered every destructive call.
 *
 * Non-reuse was deliberate ("consent is not transferable"). What changes is
 * that the SCOPE becomes the approver's to choose, rather than being fixed
 * at "this one call" or, in the only escape available, "everything".
 */

const call = (name: string, input: unknown) => ({ name, input })

describe('the keys a call can be granted under', () => {
	it('offers both an exact-call key and a whole-tool key', () => {
		const keys = toolGrantKeys(call('bash', { command: 'git status' }))
		expect(keys.tool).toBe('bash')
		expect(keys.call).toContain('bash:')
		expect(keys.call).toContain('git status')
	})

	it('is stable across argument key ORDER', () => {
		// Otherwise a grant for `{path, mode}` would not cover `{mode, path}`,
		// the same approval would be asked for twice, and the approver would
		// learn to grant the wide key instead.
		const a = toolGrantKeys(call('write', { path: '/x', mode: 'w' }))
		const b = toolGrantKeys(call('write', { mode: 'w', path: '/x' }))
		expect(a.call).toBe(b.call)
	})

	it('keeps array order, which is meaningful', () => {
		const a = toolGrantKeys(call('run', { args: ['a', 'b'] }))
		const b = toolGrantKeys(call('run', { args: ['b', 'a'] }))
		expect(a.call).not.toBe(b.call)
	})

	it('distinguishes two invocations of the same tool', () => {
		const status = toolGrantKeys(call('bash', { command: 'git status' }))
		const destroy = toolGrantKeys(call('bash', { command: 'rm -rf /' }))
		expect(status.call).not.toBe(destroy.call)
		// …while sharing the wide key, which is exactly the choice the
		// approver is being offered.
		expect(status.tool).toBe(destroy.tool)
	})
})

describe('a recorded grant', () => {
	it('covers the exact call it was granted for', () => {
		const grants = new ToolGrantSet()
		const target = call('bash', { command: 'git status' })
		grants.grant([toolGrantKeys(target).call])

		expect(grants.covers(target)).toBe(true)
	})

	it('does NOT cover a different invocation of the same tool', () => {
		// The whole point of the narrow key: approving `git status` must not
		// approve `rm -rf /`.
		const grants = new ToolGrantSet()
		grants.grant([toolGrantKeys(call('bash', { command: 'git status' })).call])

		expect(grants.covers(call('bash', { command: 'rm -rf /' }))).toBe(false)
	})

	it('covers every invocation when the wide key was granted', () => {
		const grants = new ToolGrantSet()
		grants.grant(['bash'])

		expect(grants.covers(call('bash', { command: 'anything' }))).toBe(true)
	})

	it('covers nothing by default', () => {
		expect(new ToolGrantSet().covers(call('bash', {}))).toBe(false)
	})

	it('ignores an empty grant list, so an approval that said nothing records nothing', () => {
		const grants = new ToolGrantSet()
		grants.grant(undefined)
		grants.grant([])
		grants.grant([''])

		expect(grants.size).toBe(0)
	})

	it('is enumerable, so a host can show what it has already granted', () => {
		const grants = new ToolGrantSet()
		grants.grant(['bash', 'read'])
		expect(grants.list().sort()).toEqual(['bash', 'read'])
	})

	it('does not double-count a key granted twice', () => {
		const grants = new ToolGrantSet()
		grants.grant(['bash'])
		grants.grant(['bash'])
		expect(grants.size).toBe(1)
	})
})
