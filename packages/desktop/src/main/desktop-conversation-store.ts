import { createHash, randomUUID } from 'node:crypto'
import {
	closeSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { ImageAttachment } from '@namzu/sdk'
import type { AttachmentView, ConversationView, DraftSettings } from '../shared/protocol.js'
import {
	type AdmittedAttachment,
	MAX_ATTACHMENT_BYTES,
	admitAttachment,
	validateAttachmentBatch,
} from './attachments.js'
import { projectDraftOwner } from './project-draft-owner.js'

export interface SavedDesktopConversation {
	view: ConversationView
	runtimeSessionId: string
	hasPrompted: boolean
	draft: string
	draftSettings?: DraftSettings
	providerSelection?: { provider: string; model?: string }
}
export interface SavedDesktopProjectDraft {
	ownerId: string
	draft: string
	draftSettings?: DraftSettings
}
export interface SavedDesktopAttachment extends AdmittedAttachment {
	ownerId: string
	draft: true
}
export interface DesktopConversationSnapshot {
	version: 1
	projects: { id: string; path: string }[]
	conversations: SavedDesktopConversation[]
	projectDrafts: SavedDesktopProjectDraft[]
	attachments: SavedDesktopAttachment[]
}

const MAX_FILE_BYTES = 48 * 1024 * 1024
const MAX_SAVED_ATTACHMENT_BYTES = 24 * 1024 * 1024
const MAX_DRAFT_CHARACTERS = 1_000_000
const METADATA_FILE = 'desktop-conversations.json'
const ATTACHMENT_FILE = /^desktop-draft-attachments\.[a-f0-9]{64}\.json$/
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const PERMISSION_MODES = ['prompt', 'accept-edits', 'auto', 'strict', 'plan']

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
		Object.keys(value).some((key) => !keys.includes(key))
	)
		throw new Error('Invalid saved desktop conversation data.')
	return value as Record<string, unknown>
}
function string(value: unknown, maximum: number, nonempty = true): string {
	if (typeof value !== 'string' || value.length > maximum || (nonempty && !value.trim()))
		throw new Error('Invalid saved desktop conversation string.')
	return value
}
function preset(value: unknown): 'default' {
	if (value !== 'default') throw new Error('Invalid saved model preset.')
	return value
}
function id(value: unknown): string {
	const result = string(value, 1024)
	if (
		Array.from(result).some(
			(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		)
	)
		throw new Error('Invalid saved desktop identity.')
	return result
}
function array(value: unknown, maximum: number): unknown[] {
	if (!Array.isArray(value) || value.length > maximum)
		throw new Error('Invalid saved desktop conversation list.')
	return value
}
function settings(input: unknown): DraftSettings {
	const value = record(input, ['choice', 'options'])
	const result: DraftSettings = {}
	if (value.choice !== undefined) {
		const choice = record(value.choice, ['provider', 'model', 'label', 'preset'])
		result.choice = {
			provider: string(choice.provider, 400),
			model: string(choice.model, 400),
			...(choice.label === undefined ? {} : { label: string(choice.label, 400, false) }),
			...(choice.preset === undefined ? {} : { preset: preset(choice.preset) }),
		}
	}
	if (value.options !== undefined) {
		const options = record(value.options, ['effort', 'permissionMode'])
		if (options.effort !== undefined && !EFFORTS.includes(string(options.effort, 20)))
			throw new Error('Invalid saved reasoning effort.')
		if (
			options.permissionMode !== undefined &&
			!PERMISSION_MODES.includes(string(options.permissionMode, 20))
		)
			throw new Error('Invalid saved permission mode.')
		result.options = {
			...(options.effort === undefined
				? {}
				: {
						effort: options.effort as NonNullable<DraftSettings['options']>['effort'],
					}),
			...(options.permissionMode === undefined
				? {}
				: {
						permissionMode: options.permissionMode as NonNullable<
							DraftSettings['options']
						>['permissionMode'],
					}),
		}
	}
	return result
}
function conversation(input: unknown): SavedDesktopConversation {
	const value = record(input, [
		'view',
		'runtimeSessionId',
		'hasPrompted',
		'draft',
		'draftSettings',
		'providerSelection',
	])
	const view = record(value.view, [
		'id',
		'projectId',
		'title',
		'updatedAt',
		'palId',
		'harness',
		'palGreeting',
		'pinned',
	])
	const greeting =
		view.palGreeting === undefined ? undefined : record(view.palGreeting, ['id', 'text'])
	if (greeting && view.palId === undefined) throw new Error('A greeting must belong to a Pal.')
	const updatedAt = string(view.updatedAt, 100)
	if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('Invalid saved conversation date.')
	if (
		view.harness !== undefined &&
		!['namzu', 'codex-cli', 'claude-code'].includes(string(view.harness, 30))
	)
		throw new Error('Invalid saved conversation harness.')
	if (view.pinned !== undefined && (view.pinned !== true || view.palId !== undefined))
		throw new Error('Invalid saved conversation pin.')
	if (typeof value.hasPrompted !== 'boolean') throw new Error('Invalid saved conversation state.')
	const result: SavedDesktopConversation = {
		view: {
			id: id(view.id),
			projectId: id(view.projectId),
			title: string(view.title, 4000, false),
			updatedAt,
			...(view.palId === undefined ? {} : { palId: id(view.palId) }),
			...(greeting
				? { palGreeting: { id: id(greeting.id), text: string(greeting.text, 4000) } }
				: {}),
			...(view.harness === undefined
				? {}
				: { harness: view.harness as ConversationView['harness'] }),
			...(view.pinned === true ? { pinned: true as const } : {}),
		},
		runtimeSessionId: id(value.runtimeSessionId),
		hasPrompted: value.hasPrompted,
		draft: string(value.draft, 50_000, false),
		...(value.draftSettings === undefined ? {} : { draftSettings: settings(value.draftSettings) }),
	}
	if (result.view.id.startsWith('project:')) throw new Error('Invalid saved conversation identity.')
	if (value.providerSelection !== undefined) {
		const selection = record(value.providerSelection, ['provider', 'model'])
		result.providerSelection = {
			provider: string(selection.provider, 400),
			...(selection.model === undefined ? {} : { model: string(selection.model, 400) }),
		}
	}
	return result
}
function metadata(input: unknown): Omit<DesktopConversationSnapshot, 'attachments'> {
	const value = record(input, [
		'version',
		'projects',
		'conversations',
		'projectDrafts',
		'attachments',
	])
	if (value.version !== 1) throw new Error('Unsupported saved desktop conversation version.')
	const projects = array(value.projects, 256).map((input) => {
		const item = record(input, ['id', 'path'])
		const path = string(item.path, 8192)
		if (path.includes('\u0000')) throw new Error('Invalid saved project path.')
		return { id: id(item.id), path }
	})
	const projectIds = new Set(projects.map((item) => item.id))
	if (
		projectIds.size !== projects.length ||
		new Set(projects.map((item) => item.path)).size !== projects.length
	)
		throw new Error('Duplicate saved project.')
	const conversations = array(value.conversations, 16_384).map(conversation)
	if (new Set(conversations.map((item) => item.view.id)).size !== conversations.length)
		throw new Error('Duplicate saved conversation.')
	for (const item of conversations)
		if (!projectIds.has(item.view.projectId)) throw new Error('Unknown saved conversation project.')
	const projectDrafts = array(value.projectDrafts, 32_768).map((input) => {
		const item = record(input, ['ownerId', 'draft', 'draftSettings'])
		const ownerId = id(item.ownerId)
		const owner = projectDraftOwner(ownerId)
		if (!owner || !projectIds.has(owner.projectId))
			throw new Error('Unknown saved project draft owner.')
		return {
			ownerId,
			draft: string(item.draft, 50_000, false),
			...(item.draftSettings === undefined ? {} : { draftSettings: settings(item.draftSettings) }),
		}
	})
	if (new Set(projectDrafts.map((item) => item.ownerId)).size !== projectDrafts.length)
		throw new Error('Duplicate saved project draft.')
	if (
		[...conversations, ...projectDrafts].reduce((sum, item) => sum + item.draft.length, 0) >
		MAX_DRAFT_CHARACTERS
	)
		throw new Error('Saved desktop drafts are too large.')
	return { version: 1, projects, conversations, projectDrafts }
}
function attachment(input: unknown): SavedDesktopAttachment {
	const value = record(input, ['ownerId', 'view', 'draft', 'image', 'text'])
	const view = record(value.view, ['id', 'name', 'kind', 'size', 'mediaType', 'preview'])
	if (value.draft !== true || (view.kind !== 'image' && view.kind !== 'text'))
		throw new Error('Invalid saved draft attachment.')
	if (
		!Number.isSafeInteger(view.size) ||
		(view.size as number) < 1 ||
		(view.size as number) > MAX_ATTACHMENT_BYTES
	)
		throw new Error('Invalid saved attachment size.')
	let bytes: Buffer
	if (view.kind === 'image') {
		if (value.text !== undefined) throw new Error('Invalid saved image attachment.')
		const image = record(value.image, ['type', 'data', 'mediaType'])
		if (image.type !== undefined && image.type !== 'image')
			throw new Error('Invalid saved image type.')
		const data = string(image.data, 4 * 1024 * 1024)
		bytes = Buffer.from(data, 'base64')
		if (bytes.toString('base64') !== data || image.mediaType !== view.mediaType)
			throw new Error('Invalid saved attachment encoding.')
	} else {
		if (value.image !== undefined || view.preview !== undefined)
			throw new Error('Invalid saved text attachment.')
		bytes = Buffer.from(string(value.text, 128 * 1024, false), 'utf8')
		// TextDecoder removes an initial UTF-8 BOM at admission; retain the original byte count.
		if (view.size === bytes.length + 3) bytes = Buffer.concat([Buffer.from([239, 187, 191]), bytes])
	}
	const admitted = admitAttachment({ name: string(view.name, 180), bytes })
	if (
		admitted.view.name !== view.name ||
		admitted.view.kind !== view.kind ||
		admitted.view.size !== view.size ||
		admitted.view.mediaType !== view.mediaType ||
		(view.preview !== undefined && admitted.view.preview !== view.preview) ||
		(view.kind === 'text' && admitted.text !== value.text)
	)
		throw new Error('Saved attachment does not match its content.')
	return {
		...admitted,
		ownerId: id(value.ownerId),
		draft: true,
		view: { ...admitted.view, id: id(view.id) },
	}
}
function validateOwners(snapshot: DesktopConversationSnapshot): void {
	const sessions = new Set(snapshot.conversations.map((item) => item.view.id))
	const projects = new Set(snapshot.projects.map((item) => item.id))
	const ids = new Set<string>()
	const batches = new Map<string, SavedDesktopAttachment[]>()
	let bytes = 0
	for (const file of snapshot.attachments) {
		const owner = projectDraftOwner(file.ownerId)
		if (owner ? !projects.has(owner.projectId) : !sessions.has(file.ownerId))
			throw new Error('Unknown saved attachment owner.')
		if (ids.has(file.view.id)) throw new Error('Duplicate saved attachment.')
		ids.add(file.view.id)
		bytes += file.view.size
		if (bytes > MAX_SAVED_ATTACHMENT_BYTES) throw new Error('Saved attachments are too large.')
		const batch = batches.get(file.ownerId) ?? []
		batch.push(file)
		batches.set(file.ownerId, batch)
	}
	for (const batch of batches.values()) validateAttachmentBatch(batch)
}
function parsed(input: unknown): DesktopConversationSnapshot {
	const value = record(input, [
		'version',
		'projects',
		'conversations',
		'projectDrafts',
		'attachments',
	])
	const result = {
		...metadata(value),
		attachments: array(value.attachments, 131_072).map(attachment),
	}
	validateOwners(result)
	return result
}
/** Strictly validates durable drafts, never queued prompts, approval state or runtime authority. */
export function parseDesktopConversationSnapshot(
	input: unknown,
): DesktopConversationSnapshot | null {
	try {
		return parsed(input)
	} catch {
		return null
	}
}

function sameAttachments(input: unknown[], previous: SavedDesktopAttachment[]): boolean {
	if (input.length !== previous.length) return false
	return input.every((input, at) => {
		try {
			const value = record(input, ['ownerId', 'view', 'draft', 'image', 'text'])
			const view = record(value.view, ['id', 'name', 'kind', 'size', 'mediaType', 'preview'])
			const before = previous[at] as SavedDesktopAttachment
			if (
				value.ownerId !== before.ownerId ||
				value.draft !== true ||
				value.text !== before.text ||
				['id', 'name', 'kind', 'size', 'mediaType', 'preview'].some(
					(key) => view[key] !== before.view[key as keyof AttachmentView],
				)
			)
				return false
			if (value.image === undefined) return before.image === undefined
			const image = record(value.image, ['type', 'data', 'mediaType'])
			return (
				before.image !== undefined &&
				['type', 'data', 'mediaType'].every(
					(key) => image[key] === before.image?.[key as keyof ImageAttachment],
				)
			)
		} catch {
			return false
		}
	})
}
function cloneAttachments(files: SavedDesktopAttachment[]): SavedDesktopAttachment[] {
	return files.map((file) => ({
		...file,
		view: { ...file.view },
		...(file.image ? { image: { ...file.image } } : {}),
	}))
}
function readJson(path: string): unknown {
	const descriptor = openSync(path, 'r')
	try {
		const info = fstatSync(descriptor)
		if (!info.isFile() || info.size > MAX_FILE_BYTES)
			throw new Error('Saved desktop file is too large.')
		const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_FILE_BYTES + 1))
		let size = 0
		while (size < buffer.length) {
			const read = readSync(descriptor, buffer, size, buffer.length - size, null)
			if (!read) break
			size += read
		}
		if (size > info.size) throw new Error('Saved desktop file changed while reading.')
		return JSON.parse(buffer.subarray(0, size).toString('utf8'))
	} finally {
		closeSync(descriptor)
	}
}
function atomicWrite(path: string, data: string): void {
	if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw new Error('Saved desktop file is too large.')
	const temporary = `${path}.${randomUUID()}.tmp`
	let descriptor: number | undefined
	try {
		descriptor = openSync(temporary, 'wx', 0o600)
		writeFileSync(descriptor, data, 'utf8')
		fsyncSync(descriptor)
		closeSync(descriptor)
		descriptor = undefined
		renameSync(temporary, path)
	} finally {
		if (descriptor !== undefined) closeSync(descriptor)
		try {
			unlinkSync(temporary)
		} catch {}
	}
}

/** Main-owned local persistence. Image bytes are encoded only when draft attachments change. */
export class DesktopConversationStore {
	private cachedAttachments: SavedDesktopAttachment[] = []
	private cachedAttachmentFile?: string
	private committedMetadata?: string
	constructor(private readonly directory: string) {}
	read(): DesktopConversationSnapshot | undefined {
		// Any explicit read retires the last commit assumption, even if the
		// current file is missing or invalid and needs to be repaired.
		this.committedMetadata = undefined
		let input: unknown
		try {
			input = readJson(join(this.directory, METADATA_FILE))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
			throw error
		}
		const value = record(input, [
			'version',
			'projects',
			'conversations',
			'projectDrafts',
			'attachmentFile',
		])
		let attachments: unknown[] = []
		let attachmentFile: string | undefined
		if (value.attachmentFile !== undefined) {
			attachmentFile = string(value.attachmentFile, 120)
			if (!ATTACHMENT_FILE.test(attachmentFile)) throw new Error('Invalid saved attachment file.')
			const blob = record(readJson(join(this.directory, attachmentFile)), [
				'version',
				'attachments',
			])
			if (blob.version !== 1) throw new Error('Unsupported saved attachment version.')
			attachments = array(blob.attachments, 131_072)
		}
		const snapshot = parsed({
			version: value.version,
			projects: value.projects,
			conversations: value.conversations,
			projectDrafts: value.projectDrafts,
			attachments,
		})
		this.cachedAttachments = cloneAttachments(snapshot.attachments)
		this.cachedAttachmentFile = attachmentFile
		return snapshot
	}
	write(input: DesktopConversationSnapshot): void {
		const value = record(input, [
			'version',
			'projects',
			'conversations',
			'projectDrafts',
			'attachments',
		])
		const incoming = array(value.attachments, 131_072)
		const attachmentsChanged = !sameAttachments(incoming, this.cachedAttachments)
		const attachments = attachmentsChanged
			? incoming.map(attachment)
			: cloneAttachments(this.cachedAttachments)
		const snapshot = { ...metadata(input), attachments }
		validateOwners(snapshot)
		mkdirSync(this.directory, { recursive: true, mode: 0o700 })
		let attachmentFile = this.cachedAttachmentFile
		if (attachmentsChanged || (attachments.length && !attachmentFile)) {
			if (attachments.length) {
				const data = `${JSON.stringify({
					version: 1,
					attachments: attachments.map((file) => {
						const { preview: _preview, ...view } = file.view
						return { ...file, view }
					}),
				})}\n`
				attachmentFile = `desktop-draft-attachments.${createHash('sha256').update(data).digest('hex')}.json`
				atomicWrite(join(this.directory, attachmentFile), data)
			} else attachmentFile = undefined
		}
		const { attachments: _attachments, ...saved } = snapshot
		const content = `${JSON.stringify({ ...saved, ...(attachmentFile ? { attachmentFile } : {}) })}\n`
		if (content !== this.committedMetadata) {
			atomicWrite(join(this.directory, METADATA_FILE), content)
			// Only a completed atomic commit can authorize skipping an identical write.
			this.committedMetadata = content
		}
		const previousFile = this.cachedAttachmentFile
		this.cachedAttachments = cloneAttachments(attachments)
		this.cachedAttachmentFile = attachmentFile
		if (previousFile && previousFile !== attachmentFile) {
			// Metadata already committed. A failed cleanup leaves an unreferenced private blob.
			try {
				unlinkSync(join(this.directory, previousFile))
			} catch {}
		}
	}
}
