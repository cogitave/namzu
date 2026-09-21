import { describe, expect, expectTypeOf, it } from 'vitest'
import type { SessionStore } from '../../../types/session/store.js'
import { DiskSessionStore } from '../disk.js'
import { InMemorySessionStore } from '../memory.js'

/**
 * `SessionStore` lost its message methods (spec §2.1, critique 4.5): a
 * session's conversation is its session log, read through
 * `foldSessionMessages` and written only by the turn recorder under the
 * lease. A host's own store therefore implements the entity methods and
 * nothing about messages — and must type-check doing so.
 */

type MessageMethod = 'appendMessage' | 'replaceMessages' | 'loadMessages' | 'loadSessionMessages'

/** A host store that forwards every required contract method and declares no message method. */
class ForwardingStore implements SessionStore {
	constructor(private readonly inner: SessionStore) {}
	createProject: SessionStore['createProject'] = (...a) => this.inner.createProject(...a)
	getProject: SessionStore['getProject'] = (...a) => this.inner.getProject(...a)
	createSession: SessionStore['createSession'] = (...a) => this.inner.createSession(...a)
	getSession: SessionStore['getSession'] = (...a) => this.inner.getSession(...a)
	listSessionsByTopic: SessionStore['listSessionsByTopic'] = (...a) =>
		this.inner.listSessionsByTopic(...a)
	updateSession: SessionStore['updateSession'] = (...a) => this.inner.updateSession(...a)
	deleteSession: SessionStore['deleteSession'] = (...a) => this.inner.deleteSession(...a)
	createSubSession: SessionStore['createSubSession'] = (...a) => this.inner.createSubSession(...a)
	getSubSession: SessionStore['getSubSession'] = (...a) => this.inner.getSubSession(...a)
	updateSubSession: SessionStore['updateSubSession'] = (...a) => this.inner.updateSubSession(...a)
	deleteSubSession: SessionStore['deleteSubSession'] = (...a) => this.inner.deleteSubSession(...a)
	getChildren: SessionStore['getChildren'] = (...a) => this.inner.getChildren(...a)
	getAncestry: SessionStore['getAncestry'] = (...a) => this.inner.getAncestry(...a)
	drill: SessionStore['drill'] = (...a) => this.inner.drill(...a)
	recordSummary: SessionStore['recordSummary'] = (...a) => this.inner.recordSummary(...a)
	getSummary: SessionStore['getSummary'] = (...a) => this.inner.getSummary(...a)
}

describe('a session store needs no message methods', () => {
	it('declares none on the contract', () => {
		expectTypeOf<Extract<keyof SessionStore, MessageMethod>>().toEqualTypeOf<never>()
	})

	it('accepts a host store that implements only the entity methods', async () => {
		const store: SessionStore = new ForwardingStore(new InMemorySessionStore())
		const tenantId = '62edaf4a-e86a-4e8e-bb39-662d7437216e' as Parameters<
			SessionStore['getSession']
		>[1]
		const project = await store.createProject({ tenantId, name: 'p' }, tenantId)
		expect(await store.getProject(project.id, tenantId)).toMatchObject({ id: project.id })
	})

	it('ships no message method on either kernel store', () => {
		for (const store of [new InMemorySessionStore(), new DiskSessionStore({ rootDir: '/x' })]) {
			for (const method of [
				'appendMessage',
				'replaceMessages',
				'loadMessages',
				'loadSessionMessages',
			]) {
				expect(method in store).toBe(false)
			}
		}
	})
})
