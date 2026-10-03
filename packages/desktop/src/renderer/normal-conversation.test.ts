import { expect, it } from 'vitest'
import type { ProjectView } from '../shared/protocol.js'
import { normalConversationProject } from './normal-conversation.js'

const project = (id: string, patch: Partial<ProjectView> = {}): ProjectView => ({
	id,
	name: id,
	path: `/${id}`,
	trusted: true,
	status: 'ready',
	...patch,
})

it('leaves a Pal for the remembered normal project without inheriting its workspace', () => {
	const normal = project('normal')
	const other = project('other')
	const pal = project('pal', { palId: 'owned-pal' })
	expect(normalConversationProject([other, pal, normal], pal.id, normal.id)).toBe(normal)
	expect(normalConversationProject([pal], pal.id, pal.id)).toBeUndefined()
	expect(normalConversationProject([pal, normal], normal.id, other.id)).toBe(normal)
})

it('does not reuse an untrusted or unavailable folder for a global new chat', () => {
	const unavailable = project('unavailable', { status: 'error' })
	const untrusted = project('untrusted', { trusted: false })
	const chat = project('chat', { isChat: true })
	expect(normalConversationProject([unavailable, untrusted, chat], untrusted.id)).toBe(chat)
	expect(normalConversationProject([unavailable, untrusted], unavailable.id)).toBeUndefined()
})
