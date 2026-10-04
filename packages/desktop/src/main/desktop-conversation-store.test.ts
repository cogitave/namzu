import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { admitAttachment } from './attachments.js'
import {
	type DesktopConversationSnapshot,
	DesktopConversationStore,
	type SavedDesktopAttachment,
	parseDesktopConversationSnapshot,
} from './desktop-conversation-store.js'

const io = vi.hoisted(() => ({
	failMetadataRename: false,
	attachmentRenames: 0,
	metadataRenameAttempts: 0,
	syncs: 0,
}))
vi.mock('node:fs', async () => {
	const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
	return {
		...fs,
		fsyncSync(descriptor: number) {
			io.syncs += 1
			return fs.fsyncSync(descriptor)
		},
		renameSync(from: string, to: string) {
			if (to.endsWith('desktop-conversations.json')) io.metadataRenameAttempts += 1
			if (io.failMetadataRename && to.endsWith('desktop-conversations.json'))
				throw new Error('fixture metadata commit failure')
			if (/desktop-draft-attachments\.[a-f0-9]{64}\.json$/.test(to)) io.attachmentRenames += 1
			return fs.renameSync(from, to)
		},
	}
})
const directories: string[] = []
afterEach(() => {
	io.failMetadataRename = false
	io.attachmentRenames = 0
	io.metadataRenameAttempts = 0
	io.syncs = 0
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function directory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'namzu-desktop-drafts-'))
	directories.push(directory)
	return directory
}
function snapshot(): DesktopConversationSnapshot {
	return {
		version: 1,
		projects: [{ id: 'project', path: 'C:\\workspaces\\project' }],
		conversations: [
			{
				view: {
					id: 'empty-session',
					projectId: 'project',
					title: 'New conversation',
					updatedAt: '2026-10-04T12:00:00.000Z',
					harness: 'namzu',
				},
				runtimeSessionId: 'runtime-session',
				hasPrompted: false,
				draft: 'A typed unsent draft',
				draftSettings: {
					choice: { provider: 'fixture', model: 'model', label: 'Model' },
					options: { effort: 'high', permissionMode: 'prompt' },
				},
				providerSelection: { provider: 'fixture', model: 'model' },
			},
		],
		projectDrafts: [
			{
				ownerId: 'project:project:workspace:window:home-window',
				draft: 'Landing draft',
			},
		],
		attachments: [],
	}
}
function text(ownerId = 'empty-session', content = 'notes'): SavedDesktopAttachment {
	return {
		...admitAttachment({ name: 'notes.txt', bytes: Buffer.from(content) }),
		ownerId,
		draft: true,
	}
}
function image(
	ownerId = 'empty-session',
	bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
): SavedDesktopAttachment {
	return {
		...admitAttachment({ name: 'image.png', bytes }),
		ownerId,
		draft: true,
	}
}
function metadata(directory: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(directory, 'desktop-conversations.json'), 'utf8'))
}

describe('durable desktop conversation schema', () => {
	it('preserves the original claim greeting across reload without adding a recorded model turn', () => {
		const saved = snapshot()
		const conversation = saved.conversations[0]!
		conversation.view.palId = 'pal'
		conversation.view.palGreeting = {
			id: 'pal-intro:pal:1:runtime-session',
			text: "Hey! I'm Kiro. Ready when you are. What's on your mind?",
		}
		const store = new DesktopConversationStore(directory())
		store.write(saved)
		expect(store.read()?.conversations[0]?.view.palGreeting).toEqual(conversation.view.palGreeting)
		expect(store.read()?.conversations[0]?.hasPrompted).toBe(false)
		const parsed = parseDesktopConversationSnapshot(saved)
		conversation.view.palGreeting.text = 'Changed after admission'
		expect(parsed?.conversations[0]?.view.palGreeting?.text).toContain("I'm Kiro.")
		conversation.view.palId = undefined
		expect(parseDesktopConversationSnapshot(saved)).toBeNull()
	})
	it('keeps empty UI sessions, runtime aliases, model settings and pane-scoped landing drafts', () => {
		const original = snapshot()
		original.attachments = [text(), image('project:project:workspace:window:home-window')]
		const parsed = parseDesktopConversationSnapshot(original)
		expect(parsed).toEqual(original)
		original.conversations[0]!.draftSettings!.choice!.model = 'changed afterward'
		original.attachments[0]!.view.name = 'changed afterward'
		expect(parsed?.conversations[0]?.draftSettings?.choice?.model).toBe('model')
		expect(parsed?.attachments[0]?.view.name).toBe('notes.txt')
	})
	it.each([
		(input: DesktopConversationSnapshot) => ({ ...input, version: 2 }),
		(input: DesktopConversationSnapshot) => ({
			...input,
			queue: ['replay me'],
		}),
		(input: DesktopConversationSnapshot) => {
			input.conversations[0] = {
				...input.conversations[0]!,
				running: true,
			} as never
			return input
		},
		(input: DesktopConversationSnapshot) => {
			input.conversations[0] = {
				...input.conversations[0]!,
				permissions: ['approved'],
			} as never
			return input
		},
		(input: DesktopConversationSnapshot) => {
			input.conversations[0]!.draftSettings = {
				options: { effort: 'infinite' },
			} as never
			return input
		},
		(input: DesktopConversationSnapshot) => {
			input.conversations[0]!.draftSettings = {
				options: { permissionMode: 'full-access' },
			} as never
			return input
		},
		(input: DesktopConversationSnapshot) => {
			input.conversations[0]!.draftSettings = {
				options: { attachmentIds: ['foreign'] },
			} as never
			return input
		},
		(input: DesktopConversationSnapshot) => {
			input.conversations[0]!.view.harness = 'unknown' as never
			return input
		},
		(input: DesktopConversationSnapshot) => {
			input.conversations[0]!.view.updatedAt = 'invalid'
			return input
		},
		(input: DesktopConversationSnapshot) => {
			input.conversations[0]!.providerSelection = { provider: '   ' }
			return input
		},
		(input: DesktopConversationSnapshot) => {
			input.projectDrafts[0]!.ownerId = 'project:project:workspace:foreign'
			return input
		},
	])('rejects an unsupported shape or selection %#', (alter) => {
		expect(parseDesktopConversationSnapshot(alter(snapshot()))).toBeNull()
	})
	it('rejects duplicate identities, orphaned sessions and foreign draft owners', () => {
		const duplicateSession = snapshot()
		duplicateSession.conversations.push(structuredClone(duplicateSession.conversations[0]!))
		expect(parseDesktopConversationSnapshot(duplicateSession)).toBeNull()
		const duplicateProject = snapshot()
		duplicateProject.projects.push({
			id: 'other',
			path: duplicateProject.projects[0]!.path,
		})
		expect(parseDesktopConversationSnapshot(duplicateProject)).toBeNull()
		const foreign = snapshot()
		foreign.conversations[0]!.view.projectId = 'missing'
		expect(parseDesktopConversationSnapshot(foreign)).toBeNull()
		const foreignAttachment = snapshot()
		foreignAttachment.attachments = [text('foreign-session')]
		expect(parseDesktopConversationSnapshot(foreignAttachment)).toBeNull()
	})
	it('checks per-draft, aggregate draft and bounded session counts', () => {
		const tooLong = snapshot()
		tooLong.conversations[0]!.draft = 'a'.repeat(50_001)
		expect(parseDesktopConversationSnapshot(tooLong)).toBeNull()
		const aggregate = snapshot()
		aggregate.conversations = Array.from({ length: 21 }, (_, at) => ({
			...aggregate.conversations[0]!,
			view: { ...aggregate.conversations[0]!.view, id: `session-${at}` },
			draft: 'a'.repeat(50_000),
		}))
		expect(parseDesktopConversationSnapshot(aggregate)).toBeNull()
		const tooMany = snapshot()
		tooMany.conversations = Array.from({ length: 16_385 }, (_, at) => ({
			...tooMany.conversations[0]!,
			view: { ...tooMany.conversations[0]!.view, id: `session-${at}` },
			draft: '',
		}))
		expect(parseDesktopConversationSnapshot(tooMany)).toBeNull()
	})
	it('validates attachment content and restores original IDs with a reconstructed preview', () => {
		const original = snapshot()
		const file = image()
		original.attachments = [file]
		original.attachments[0]!.view.preview = undefined
		const parsed = parseDesktopConversationSnapshot(original)
		expect(parsed?.attachments[0]?.view.id).toBe(file.view.id)
		expect(parsed?.attachments[0]?.view.preview).toBe(`data:image/png;base64,${file.image?.data}`)
		original.attachments[0]!.view.mediaType = 'image/jpeg'
		expect(parseDesktopConversationSnapshot(original)).toBeNull()
	})
	it('accepts UTF-8 BOM and whitespace text already admitted by the application', () => {
		const original = snapshot()
		original.attachments = [
			{
				...admitAttachment({
					name: 'bom.txt',
					bytes: Buffer.from([239, 187, 191]),
				}),
				ownerId: 'empty-session',
				draft: true,
			},
			text('empty-session', '  \n'),
		]
		expect(parseDesktopConversationSnapshot(original)).toEqual(original)
	})
	it.each([
		(file: SavedDesktopAttachment) => {
			file.view.size += 1
		},
		(file: SavedDesktopAttachment) => {
			file.view.preview = 'data:image/png;base64,spoofed'
		},
		(file: SavedDesktopAttachment) => {
			file.image = { ...file.image!, data: '%%%not-base64' }
		},
		(file: SavedDesktopAttachment) => {
			file.draft = false as never
		},
		(file: SavedDesktopAttachment) => {
			file.text = 'another content kind'
		},
	])('rejects an altered attachment %#', (alter) => {
		const original = snapshot()
		original.attachments = [image()]
		alter(original.attachments[0]!)
		expect(parseDesktopConversationSnapshot(original)).toBeNull()
	})
	it('checks per-message attachment count and duplicate attachment identities', () => {
		const count = snapshot()
		count.attachments = Array.from({ length: 9 }, () => text())
		expect(parseDesktopConversationSnapshot(count)).toBeNull()
		const duplicate = snapshot()
		const file = text()
		duplicate.attachments = [file, structuredClone(file)]
		expect(parseDesktopConversationSnapshot(duplicate)).toBeNull()
	})
	it('bounds aggregate attachment bytes across independent conversations', () => {
		const original = snapshot()
		const bytes = Buffer.alloc(3 * 1024 * 1024)
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
		const file = image('empty-session', bytes)
		original.conversations = Array.from({ length: 9 }, (_, at) => ({
			...original.conversations[0]!,
			view: { ...original.conversations[0]!.view, id: `session-${at}` },
		}))
		original.attachments = original.conversations.map((item, at) => ({
			...file,
			ownerId: item.view.id,
			view: { ...file.view, id: `attachment-${at}` },
		}))
		expect(parseDesktopConversationSnapshot(original)).toBeNull()
	})
})

describe('atomic private desktop persistence', () => {
	it('returns undefined only for missing metadata and rejects invalid persisted data', () => {
		const location = directory()
		const store = new DesktopConversationStore(location)
		expect(store.read()).toBeUndefined()
		writeFileSync(join(location, 'desktop-conversations.json'), '{broken')
		expect(() => store.read()).toThrow()
		writeFileSync(join(location, 'desktop-conversations.json'), JSON.stringify({ version: 2 }))
		expect(() => store.read()).toThrow()
	})
	it('round trips unprompted conversations and draft attachment bytes across store instances', () => {
		const location = directory()
		const original = snapshot()
		original.attachments = [image(), text('project:project:workspace:window:home-window')]
		new DesktopConversationStore(location).write(original)
		expect(new DesktopConversationStore(location).read()).toEqual(original)
		const saved = metadata(location)
		expect(saved).not.toHaveProperty('attachments')
		const blob = readFileSync(join(location, saved.attachmentFile as string), 'utf8')
		expect(blob).not.toContain('preview')
		if (process.platform !== 'win32') {
			expect(statSync(join(location, 'desktop-conversations.json')).mode & 0o777).toBe(0o600)
			expect(statSync(join(location, saved.attachmentFile as string)).mode & 0o777).toBe(0o600)
		}
	})
	it('writes only small metadata for draft edits and rewrites a blob when attachment ownership changes', () => {
		const location = directory()
		const store = new DesktopConversationStore(location)
		const original = snapshot()
		original.attachments = [image()]
		store.write(original)
		expect(io.attachmentRenames).toBe(1)
		const blob = metadata(location).attachmentFile
		original.conversations[0]!.draft = 'later draft'
		store.write(structuredClone(original))
		expect(io.attachmentRenames).toBe(1)
		expect(metadata(location).attachmentFile).toBe(blob)
		original.attachments[0]!.ownerId = 'project:project:workspace:window:home-window'
		store.write(original)
		expect(io.attachmentRenames).toBe(2)
		expect(metadata(location).attachmentFile).not.toBe(blob)
		expect(new DesktopConversationStore(location).read()).toEqual(original)
	})
	it('skips identical committed metadata without another disk flush while preserving changed drafts', () => {
		const location = directory()
		const store = new DesktopConversationStore(location)
		const original = snapshot()
		original.attachments = [text()]
		store.write(original)
		expect(io.metadataRenameAttempts).toBe(1)
		expect(io.attachmentRenames).toBe(1)
		expect(io.syncs).toBe(2)
		store.write(structuredClone(original))
		store.write(structuredClone(original))
		expect(io.metadataRenameAttempts).toBe(1)
		expect(io.attachmentRenames).toBe(1)
		expect(io.syncs).toBe(2)
		const changed = structuredClone(original)
		changed.conversations[0]!.draft = 'Durable changed draft'
		store.write(changed)
		expect(io.metadataRenameAttempts).toBe(2)
		expect(io.syncs).toBe(3)
		expect(new DesktopConversationStore(location).read()).toEqual(changed)
	})
	it.each(['missing', 'invalid'])(
		'repairs %s metadata after a read retires the last commit assumption',
		(state) => {
			const location = directory()
			const store = new DesktopConversationStore(location)
			const original = snapshot()
			store.write(original)
			const file = join(location, 'desktop-conversations.json')
			if (state === 'missing') {
				unlinkSync(file)
				expect(store.read()).toBeUndefined()
			} else {
				writeFileSync(file, '{invalid metadata')
				expect(() => store.read()).toThrow()
			}
			store.write(structuredClone(original))
			expect(io.metadataRenameAttempts).toBe(2)
			expect(new DesktopConversationStore(location).read()).toEqual(original)
		},
	)
	it('retries failed changed metadata instead of caching an uncommitted candidate', () => {
		const location = directory()
		const store = new DesktopConversationStore(location)
		const original = snapshot()
		store.write(original)
		const changed = structuredClone(original)
		changed.conversations[0]!.draft = 'Retry this authored change'
		io.failMetadataRename = true
		expect(() => store.write(changed)).toThrow('fixture metadata commit failure')
		expect(io.metadataRenameAttempts).toBe(2)
		expect(new DesktopConversationStore(location).read()).toEqual(original)
		io.failMetadataRename = false
		store.write(changed)
		expect(io.metadataRenameAttempts).toBe(3)
		expect(io.syncs).toBe(3)
		expect(new DesktopConversationStore(location).read()).toEqual(changed)
		store.write(structuredClone(changed))
		expect(io.metadataRenameAttempts).toBe(3)
		expect(io.syncs).toBe(3)
	})
	it('does not overwrite the committed state when an invalid new snapshot is supplied', () => {
		const location = directory()
		const store = new DesktopConversationStore(location)
		const original = snapshot()
		store.write(original)
		const invalid = structuredClone(original)
		invalid.conversations[0]!.draft = 'a'.repeat(50_001)
		expect(() => store.write(invalid)).toThrow()
		expect(new DesktopConversationStore(location).read()).toEqual(original)
	})
	it('retains the previously committed attachment blob if the metadata rename fails', () => {
		const location = directory()
		const store = new DesktopConversationStore(location)
		const original = snapshot()
		original.attachments = [text()]
		store.write(original)
		const later = structuredClone(original)
		later.attachments = [image()]
		later.conversations[0]!.draft = 'later'
		io.failMetadataRename = true
		expect(() => store.write(later)).toThrow('fixture metadata commit failure')
		expect(io.metadataRenameAttempts).toBe(2)
		expect(new DesktopConversationStore(location).read()).toEqual(original)
		expect(readdirSync(location).some((file) => file.endsWith('.tmp'))).toBe(false)
		io.failMetadataRename = false
		store.write(later)
		expect(io.metadataRenameAttempts).toBe(3)
		expect(new DesktopConversationStore(location).read()).toEqual(later)
	})
	it('rejects a missing referenced attachment file and an escaping blob path', () => {
		const location = directory()
		const store = new DesktopConversationStore(location)
		const original = snapshot()
		original.attachments = [image()]
		store.write(original)
		const saved = metadata(location)
		rmSync(join(location, saved.attachmentFile as string))
		expect(() => store.read()).toThrow()
		writeFileSync(
			join(location, 'desktop-conversations.json'),
			JSON.stringify({ ...saved, attachmentFile: '../foreign.json' }),
		)
		expect(() => store.read()).toThrow('Invalid saved attachment file')
	})
	it('bounds a persisted file before attempting to allocate or parse its contents', () => {
		const location = directory()
		const path = join(location, 'desktop-conversations.json')
		writeFileSync(path, '')
		truncateSync(path, 48 * 1024 * 1024 + 1)
		expect(() => new DesktopConversationStore(location).read()).toThrow('too large')
	})
	it('isolates its validated cache from later mutation of an input or read result', () => {
		const location = directory()
		const store = new DesktopConversationStore(location)
		const original = snapshot()
		original.attachments = [image()]
		store.write(original)
		const result = store.read()!
		result.attachments[0]!.image = {
			...result.attachments[0]!.image!,
			data: 'not base64',
		}
		expect(() => store.write(result)).toThrow()
		store.write(original)
		expect(new DesktopConversationStore(location).read()).toEqual(original)
	})
})
