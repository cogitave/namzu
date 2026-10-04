import { describe, expect, it, vi } from 'vitest'
import { PalScenePool } from './pal-scene-pool.js'

function scene() {
	let alive = true
	return {
		get valid() {
			return alive
		},
		invalidate: () => {
			alive = false
		},
		suspend: vi.fn(),
		dispose: vi.fn(() => {
			alive = false
		}),
	}
}

type Scene = ReturnType<typeof scene>
const appearance = JSON.stringify(['sprite', 'lime', 'small'])

describe('decorative Pal scene leases', () => {
	it('reuses the exact idle scene without constructing or disposing another renderer', () => {
		const pool = new PalScenePool<Scene>()
		const original = scene()
		const create = vi.fn(() => original)
		const first = pool.acquire(appearance, create)
		expect(first.scene).toBe(original)
		expect(original.suspend).not.toHaveBeenCalled()
		first.release()
		expect(original.suspend).toHaveBeenCalledOnce()
		const next = pool.acquire(appearance, create)
		expect(next.scene).toBe(original)
		expect(create).toHaveBeenCalledOnce()
		expect(original.dispose).not.toHaveBeenCalled()
	})

	it.each([
		['character', JSON.stringify(['sage', 'lime', 'small'])],
		['color', JSON.stringify(['sprite', 'orange', 'small'])],
		['size', JSON.stringify(['sprite', 'lime', 'large'])],
	])('keeps a changed %s appearance isolated from the original idle scene', (_, key) => {
		const pool = new PalScenePool<Scene>()
		const original = scene()
		const different = scene()
		pool.acquire(appearance, () => original).release()
		const changed = pool.acquire(key, () => different)
		expect(changed.scene).toBe(different)
		const restore = pool.acquire(
			appearance,
			vi.fn(() => scene()),
		)
		expect(restore.scene).toBe(original)
		expect(original.dispose).not.toHaveBeenCalled()
	})

	it('never lends a renderer already owned by another active view', () => {
		const pool = new PalScenePool<Scene>()
		const firstScene = scene()
		const secondScene = scene()
		const create = vi.fn().mockReturnValueOnce(firstScene).mockReturnValueOnce(secondScene)
		const first = pool.acquire(appearance, create)
		const second = pool.acquire(appearance, create)
		expect(second.scene).not.toBe(first.scene)
		expect(create).toHaveBeenCalledTimes(2)
		first.release()
		const third = pool.acquire(appearance, create)
		expect(third.scene).toBe(firstScene)
		expect(third.scene).not.toBe(second.scene)
		expect(secondScene.suspend).not.toHaveBeenCalled()
		expect(secondScene.dispose).not.toHaveBeenCalled()
		expect(create).toHaveBeenCalledTimes(2)
	})

	it('retains at most two idle scenes and evicts by release order', () => {
		const pool = new PalScenePool<Scene>()
		const first = scene()
		const second = scene()
		const third = scene()
		const a = pool.acquire('first', () => first)
		const b = pool.acquire('second', () => second)
		const c = pool.acquire('third', () => third)
		b.release()
		a.release()
		c.release()
		expect(second.suspend).toHaveBeenCalledOnce()
		expect(second.dispose).toHaveBeenCalledOnce()
		expect(first.dispose).not.toHaveBeenCalled()
		expect(third.dispose).not.toHaveBeenCalled()
		expect(pool.acquire('first', () => scene()).scene).toBe(first)
		expect(pool.acquire('third', () => scene()).scene).toBe(third)
		const replacement = pool.acquire('second', () => scene())
		expect(replacement.scene).not.toBe(second)
	})

	it('releases a lease only once, without adding duplicate idle ownership', () => {
		const pool = new PalScenePool<Scene>()
		const original = scene()
		const first = pool.acquire(appearance, () => original)
		first.release()
		first.release()
		first.release(true)
		expect(original.suspend).toHaveBeenCalledOnce()
		expect(original.dispose).not.toHaveBeenCalled()
		expect(pool.acquire(appearance, () => scene()).scene).toBe(original)
		expect(pool.acquire(appearance, () => scene()).scene).not.toBe(original)
	})

	it('disposes an invalid idle scene instead of returning it to a new owner', () => {
		const pool = new PalScenePool<Scene>()
		const invalid = scene()
		const unaffected = scene()
		pool.acquire(appearance, () => invalid).release()
		pool.acquire('other', () => unaffected).release()
		invalid.invalidate()
		const replacement = pool.acquire(appearance, () => scene())
		expect(replacement.scene).not.toBe(invalid)
		expect(replacement.scene.valid).toBe(true)
		expect(invalid.dispose).toHaveBeenCalledOnce()
		expect(pool.acquire('other', () => scene()).scene).toBe(unaffected)
		expect(unaffected.dispose).not.toHaveBeenCalled()
	})

	it('does not admit an invalid active scene when its owner releases it', () => {
		const pool = new PalScenePool<Scene>()
		const failed = scene()
		const lease = pool.acquire(appearance, () => failed)
		failed.invalidate()
		lease.release()
		expect(failed.suspend).toHaveBeenCalledOnce()
		expect(failed.dispose).toHaveBeenCalledOnce()
		expect(pool.acquire(appearance, () => scene()).scene).not.toBe(failed)
	})

	it('removes a context-lost idle scene immediately when explicitly discarded', () => {
		const pool = new PalScenePool<Scene>()
		const failed = scene()
		pool.acquire(appearance, () => failed).release()
		pool.discard(failed)
		expect(failed.dispose).toHaveBeenCalledOnce()
		expect(pool.acquire(appearance, () => scene()).scene).not.toBe(failed)
	})

	it('keeps unrelated idle resources available after renderer construction fails', () => {
		const pool = new PalScenePool<Scene>()
		const unaffected = scene()
		pool.acquire('existing', () => unaffected).release()
		const failedCreate = vi.fn(() => {
			throw new Error('WebGL construction failed')
		})
		expect(() => pool.acquire('new', failedCreate)).toThrow('WebGL construction failed')
		expect(failedCreate).toHaveBeenCalledOnce()
		expect(unaffected.dispose).not.toHaveBeenCalled()
		expect(pool.acquire('existing', () => scene()).scene).toBe(unaffected)
		expect(pool.acquire('new', () => scene()).scene.valid).toBe(true)
	})

	it('clears only idle resources and leaves another active owner intact', () => {
		const pool = new PalScenePool<Scene>()
		const idle = scene()
		const active = scene()
		pool.acquire('idle', () => idle).release()
		const owner = pool.acquire('active', () => active)
		pool.clear()
		pool.clear()
		expect(idle.dispose).toHaveBeenCalledOnce()
		expect(active.suspend).not.toHaveBeenCalled()
		expect(active.dispose).not.toHaveBeenCalled()
		owner.release()
		expect(pool.acquire('active', () => scene()).scene).toBe(active)
	})

	it('reduced-motion cleanup discards its active lease and releases every idle scene', () => {
		const pool = new PalScenePool<Scene>()
		const idle = scene()
		const active = scene()
		pool.acquire('idle', () => idle).release()
		const owner = pool.acquire(appearance, () => active)
		owner.release(true)
		pool.clear()
		owner.release()
		expect(active.suspend).toHaveBeenCalledOnce()
		expect(active.dispose).toHaveBeenCalledOnce()
		expect(idle.dispose).toHaveBeenCalledOnce()
		expect(pool.acquire(appearance, () => scene()).scene).not.toBe(active)
		expect(pool.acquire('idle', () => scene()).scene).not.toBe(idle)
	})

	it('can disable idle retention without retaining a released renderer', () => {
		const pool = new PalScenePool<Scene>(0)
		const original = scene()
		pool.acquire(appearance, () => original).release()
		expect(original.suspend).toHaveBeenCalledOnce()
		expect(original.dispose).toHaveBeenCalledOnce()
		expect(pool.acquire(appearance, () => scene()).scene).not.toBe(original)
	})
})
