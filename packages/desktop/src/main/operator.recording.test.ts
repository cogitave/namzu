import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { DesktopEvent, PermissionView } from '../shared/protocol.js'
import { EMPTY_CUT, type RecordingResult } from '../shared/recording-protocol.js'
import { Operator } from './operator.js'
import { composerText, recordingBlock, recordingChipName } from './recording/message.js'

const operators: Operator[] = []
afterEach(async () => {
	await Promise.all(operators.splice(0).map((owner) => owner.close()))
})

function harness() {
	const events = new EventEmitter()
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
		},
		(event) => events.emit('update', event),
	)
	operators.push(owner)
	const permission = (): Promise<PermissionView> =>
		new Promise((resolve) => {
			const receive = (event: DesktopEvent) => {
				if (event.kind !== 'permission') return
				events.off('update', receive)
				resolve(event.request)
			}
			events.on('update', receive)
		})
	return { owner, permission }
}

const result: RecordingResult = {
	id: 'r',
	durationMs: 192_000,
	stopReason: 'done',
	events: [
		{ t: 0, type: 'start', display: { w: 2560, h: 1440 }, frame: 1 },
		{ t: 6200, type: 'invoke', role: 'Button', name: 'Export', frame: 2 },
		{ t: 9000, type: 'stop', reason: 'done', frame: 2 },
	],
	frames: [],
	cut: { ...EMPTY_CUT },
	voice: 'off',
	display: { w: 2560, h: 1440, shownW: 1280, shownH: 720 },
	controls: true,
	typingNote: false,
}
const frames = [1, 2].map((index) => ({
	index,
	t: index,
	jpeg: Buffer.from([255, 216, 255, index]),
	event: false,
}))
const payload = () => ({
	name: recordingChipName(result.durationMs),
	text: recordingBlock({ result, frames, imageInput: true }),
	images: frames.map((frame) => ({
		name: `frame-0${frame.index}.jpg`,
		data: Buffer.from(frame.jpeg).toString('base64'),
	})),
})

it('sends a recording as one attachment with its pictures, and the message asks for the save card', async () => {
	const { owner, permission } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const views = owner.addRecording(session.id, payload())
	expect(views).toEqual([
		expect.objectContaining({
			name: 'Screen recording 3:12',
			kind: 'text',
			mediaType: 'application/x-namzu-recording',
		}),
	])
	const asked = permission()
	owner.send(session.id, composerText(undefined), { attachmentIds: views.map((view) => view.id) })
	const request = await asked
	const input = request.calls[0]?.input as { prompt: string; attachments: { mediaType: string }[] }
	// The model is told to use skill-creator and to call save_skill, which opens the existing save card.
	expect(input.prompt).toContain('Load the skill-creator skill')
	expect(input.prompt).toContain('call save_skill with origin "learned"')
	expect(input.prompt).toContain('Do not write skill files yourself.')
	expect(input.prompt).toContain('<screen-recording version="1"')
	expect(input.prompt).toContain('Attached text file: "Screen recording 3:12"')
	expect(input.attachments).toHaveLength(2)
	expect(input.attachments.every((image) => image.mediaType === 'image/jpeg')).toBe(true)
})

it('holds a recording in memory only: it is not in the saved drafts', async () => {
	const { owner } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	owner.addRecording(session.id, payload())
	const saved = JSON.stringify((owner as unknown as { savedDesktop?: unknown }).savedDesktop ?? {})
	expect(saved).not.toContain('screen-recording')
	expect(saved).not.toContain(payload().images[0]?.data ?? 'never')
})

it('replaces a recording still waiting in the draft, and refuses a bad shape and an oversized one', async () => {
	const { owner } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	owner.addRecording(session.id, payload())
	expect(owner.addRecording(session.id, payload())).toHaveLength(1)
	const other = await owner.newConversation(project.id)
	expect(() => owner.addRecording(other.id, { name: 'x', text: 'y', images: 'no' })).toThrow(
		'Invalid recording',
	)
	expect(() =>
		owner.addRecording(other.id, { name: 'x', text: 'y', images: [{ data: '***' }] }),
	).toThrow('Invalid recording')
	const big = Buffer.alloc(7 * 1024 * 1024).toString('base64')
	expect(() =>
		owner.addRecording(other.id, { name: 'x', text: 'y', images: [{ data: big }] }),
	).toThrow('too large')
	expect(() =>
		owner.addRecording(other.id, { name: 'x', text: 'y'.repeat(70_000), images: [] }),
	).toThrow('too long')
})

it('does not count a recording against the ordinary file limits', async () => {
	const { owner } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const files = owner.addAttachments(session.id, [{ name: 'notes.txt', bytes: Buffer.from('x') }])
	const withRecording = owner.addRecording(session.id, payload())
	expect(withRecording).toHaveLength(2)
	expect(files).toHaveLength(1)
})
