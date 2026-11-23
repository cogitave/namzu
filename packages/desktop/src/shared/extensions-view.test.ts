import { describe, expect, it } from 'vitest'
import {
	EXTENSION_BRIDGE_METHODS,
	readAudit,
	readDisclosure,
	readExtensionList,
	readFailure,
	readNotice,
	readStateEvent,
} from './extensions-view.js'

const ROW = {
	id: 'com.example.stub',
	name: 'Stub',
	version: '1.0.0',
	publisher: 'Example',
	state: 'running',
	chip: 'Recording',
	dev: false,
	needs: ['notice', 'banana'],
	enabled: true,
	languages: ['en', 'tr'],
	shownLocale: 'en',
	running: true,
	grants: [],
	indicator: { level: 'ok', label: 'Counting.' },
	secret: 'never copied',
}

describe('the administrator lock in what is read', () => {
	it('reads whether it is locked, the reason and the wait, and ignores another kind of lock', () => {
		const [row] =
			readExtensionList({
				extensions: [
					{
						...ROW,
						management: {
							lock: 'administrator-password',
							locked: true,
							purpose: 'Your organisation keeps this on.',
							waitSeconds: 4.2,
						},
					},
				],
			}) ?? []
		expect(row?.management).toEqual({
			locked: true,
			purpose: 'Your organisation keeps this on.',
			waitSeconds: 5,
		})
		const [other] =
			readExtensionList({ extensions: [{ ...ROW, management: { lock: 'pin', locked: true } }] }) ??
			[]
		expect(other?.management).toBeUndefined()
	})
	it('lets Namzu Settings send the administrator unlock request', () => {
		expect(EXTENSION_BRIDGE_METHODS).toContain('namzu/extensions/unlock')
	})
})

describe('the extension readers', () => {
	it('copy only the fields they know and drop the rest', () => {
		const rows = readExtensionList({
			extensions: [ROW, { id: 'x' }, 'nope', { ...ROW, state: 'exploded' }],
		})
		expect(rows).toHaveLength(1)
		expect(rows?.[0]).toMatchObject({
			id: 'com.example.stub',
			needs: ['notice'],
			indicator: { level: 'ok', label: 'Counting.' },
		})
		expect(JSON.stringify(rows)).not.toContain('never copied')
	})
	it('refuse an answer that is not a list', () => {
		expect(readExtensionList({})).toBeUndefined()
		expect(readExtensionList('x')).toBeUndefined()
	})
	it('clip very long text', () => {
		const rows = readExtensionList({ extensions: [{ ...ROW, name: 'n'.repeat(5000) }] })
		expect(rows?.[0]?.name).toHaveLength(200)
	})
	it('read a disclosure and a notice, tolerant of what a newer engine adds', () => {
		const disclosure = {
			extensionId: 'com.example.stub',
			name: 'Stub',
			version: '1.0.0',
			publisher: { name: 'Example', contact: 'a@b.test' },
			shownLocale: 'en',
			permissions: [
				{
					id: 'os.foregroundWindow',
					level: 'medium',
					optional: false,
					summary: 's',
					purposes: ['p'],
					future: 1,
				},
				{ nope: 1 },
			],
			network: 'It does not use the network.',
			dataFolder: '/d',
			dataKinds: [
				{
					id: 'a.b',
					description: 'd',
					fields: [{ name: 'minute', description: 'm' }],
					retentionDays: 7,
				},
			],
			doesNotCollect: ['keys'],
			doesNotDo: [],
			storage: { where: 'here', encryption: 'file', adminCanRead: true },
			leavesTheMachine: 'Nothing leaves this computer.',
			controller: 'You',
			licenseRequired: true,
			noticeVersion: '1.0',
		}
		expect(readDisclosure(disclosure)?.permissions).toHaveLength(1)
		const notice = readNotice({
			noticeVersion: '1.0',
			scopeHash: 'a'.repeat(64),
			locale: 'en',
			text: 'Hello',
			scopeWords: ['w'],
			disclosure,
			record: null,
			diff: ['d'],
		})
		expect(notice).toMatchObject({ noticeVersion: '1.0', record: null, diff: ['d'] })
		expect(readNotice({ noticeVersion: '1.0' })).toBeUndefined()
	})
	it('read a refusal answered instead of thrown, an audit list, and a state event', () => {
		expect(
			readFailure({ error: { code: 'tampered', check: 'file-hash', message: 'changed' } }),
		).toEqual({ code: 'tampered', check: 'file-hash', message: 'changed' })
		expect(readFailure({ ok: true })).toBeUndefined()
		expect(
			readAudit({ lines: [{ ts: '2026-01-01T00:00:00Z', event: 'added' }, { event: 'x' }] }),
		).toHaveLength(1)
		expect(
			readStateEvent({
				id: 'a.b.c',
				state: 'running',
				since: 5,
				indicator: { level: 'warn', label: 'gaps' },
			}),
		).toEqual({
			id: 'a.b.c',
			state: 'running',
			since: 5,
			indicator: { level: 'warn', label: 'gaps' },
		})
		expect(readStateEvent({ id: 'a.b.c', state: 'weird' })).toBeUndefined()
	})
	it('the bridge never offers a way to add by path', () => {
		expect(EXTENSION_BRIDGE_METHODS).not.toContain('namzu/extensions/add')
		expect(EXTENSION_BRIDGE_METHODS.every((m) => m.startsWith('namzu/extensions/'))).toBe(true)
	})
})
