import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadConfig } from '../../../config/load.js'
import {
	DECISION_KEY_ID,
	connectedPointsNotice,
	decisionStatusLine,
	readBoundDecisionKey,
	readConnection,
	readDecisionKey,
	readOffer,
	readUserDecisionSetting,
	recordOffer,
	resetBoundKeyCache,
	shouldOfferDecisionSetup,
	writeConnection,
} from '../connection.js'
import { saveConnection } from '../setup.js'

function scratch() {
	const home = mkdtempSync(join(tmpdir(), 'namzu-decision-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	return { home, env: {} as NodeJS.ProcessEnv, opts: { home, env: {} as NodeJS.ProcessEnv } }
}
const DAY = 24 * 60 * 60 * 1000

describe('the offer', () => {
	const base = { setting: 'absent', env: {}, now: 10 * DAY } as const

	it('is made when it was never answered', () => {
		expect(shouldOfferDecisionSetup({ ...base, record: undefined })).toBe(true)
	})

	it('after Not now waits a day, then asks again', () => {
		const at = new Date(10 * DAY - DAY / 2).toISOString()
		expect(shouldOfferDecisionSetup({ ...base, record: { answer: 'later', at } })).toBe(false)
		const old = new Date(10 * DAY - DAY).toISOString()
		expect(shouldOfferDecisionSetup({ ...base, record: { answer: 'later', at: old } })).toBe(true)
	})

	it('after Dont ask again never asks', () => {
		expect(
			shouldOfferDecisionSetup({
				...base,
				now: 1000 * DAY,
				record: { answer: 'never', at: new Date(0).toISOString() },
			}),
		).toBe(false)
	})

	it('is not made once a model is configured, or under the kill switch', () => {
		expect(shouldOfferDecisionSetup({ ...base, record: undefined, setting: 'block' })).toBe(false)
		expect(shouldOfferDecisionSetup({ ...base, record: undefined, setting: 'shorthand' })).toBe(
			false,
		)
		expect(
			shouldOfferDecisionSetup({ ...base, record: undefined, env: { NAMZU_NO_DECISION: '1' } }),
		).toBe(false)
	})

	it('is remembered in a file, and a damaged file reads as never asked', () => {
		const { opts, home } = scratch()
		expect(readOffer(opts)).toBeUndefined()
		recordOffer('later', opts, () => new Date('2030-01-02T03:04:05Z'))
		expect(readOffer(opts)).toEqual({ answer: 'later', at: '2030-01-02T03:04:05.000Z' })
		writeFileSync(join(home, '.namzu', 'decision-offer.json'), '{nope')
		expect(readOffer(opts)).toBeUndefined()
	})
})

describe('saving a connection', () => {
	it('puts the key in the private store and everything else in the config, never the key', () => {
		const { opts, home } = scratch()
		const out = saveConnection(
			{
				kind: 'azure',
				endpoint: 'https://r.services.ai.azure.com',
				deployment: 'dep',
				key: 'SECRET-KEY-0123456789abcdef',
			},
			opts,
		)
		const config = readFileSync(out.configFile, 'utf8')
		expect(config).toContain('https://r.services.ai.azure.com')
		expect(config).toContain('deployment: dep')
		expect(config).not.toContain('SECRET-KEY')
		expect(readFileSync(join(home, '.namzu', 'decision-connection.json'), 'utf8')).not.toContain(
			'SECRET-KEY',
		)
		expect(readDecisionKey(opts)).toBe('SECRET-KEY-0123456789abcdef')
		const store = JSON.parse(readFileSync(join(home, '.namzu', 'api-keys.json'), 'utf8'))
		expect(store.keys[DECISION_KEY_ID]).toBe('SECRET-KEY-0123456789abcdef')
	})

	it('writes the default points: notify and skill on, memory and pick only recorded', () => {
		const { opts } = scratch()
		saveConnection({ kind: 'http', url: 'http://127.0.0.1:9/x' }, opts)
		const cfg = loadConfig({ ...opts, cwd: mkdtempSync(join(tmpdir(), 'cwd-')) })
		expect(cfg.decision).toEqual({
			provider: 'http',
			url: 'http://127.0.0.1:9/x',
			points: { notify: 'on', memory: 'shadow', skill: 'on', pick: 'shadow' },
		})
		expect(readDecisionKey(opts)).toBeNull()
	})

	it('keeps the rest of the user config as it was', () => {
		const { opts, home } = scratch()
		writeFileSync(join(home, '.namzu', 'config.yaml'), '# mine\nnotifications: false\n')
		saveConnection({ kind: 'http', url: 'http://h:1/x', model: 'm' }, opts)
		const text = readFileSync(join(home, '.namzu', 'config.yaml'), 'utf8')
		expect(text).toContain('# mine')
		expect(text).toContain('notifications: false')
		expect(readConnection(opts)).toEqual({ provider: 'http', url: 'http://h:1/x', model: 'm' })
	})

	it('refuses a draft with no address', () => {
		expect(() =>
			saveConnection(
				{ kind: 'azure', endpoint: 'https://r.services.ai.azure.com' },
				scratch().opts,
			),
		).toThrow(/address/)
	})
})

describe('decision: true', () => {
	const load = (opts: { home: string; env: NodeJS.ProcessEnv }) =>
		loadConfig({ ...opts, cwd: mkdtempSync(join(tmpdir(), 'cwd-')) })

	it('means the connected model, with the default points', () => {
		const { opts, home } = scratch()
		writeConnection({ provider: 'http', url: 'http://h:1/x' }, opts)
		writeFileSync(join(home, '.namzu', 'config.yaml'), 'decision: true\n')
		expect(load(opts).decision).toMatchObject({
			provider: 'http',
			url: 'http://h:1/x',
			points: { notify: 'on', skill: 'on', memory: 'shadow', pick: 'shadow' },
		})
	})

	it('means nothing when nothing is connected, and says so to the terminal', () => {
		const { opts, home } = scratch()
		writeFileSync(join(home, '.namzu', 'config.yaml'), 'decision: true\n')
		expect(load(opts).decision).toBeUndefined()
		expect(readUserDecisionSetting(opts)).toBe('shorthand')
	})

	it('leaves the full block working unchanged', () => {
		const { opts, home } = scratch()
		writeFileSync(
			join(home, '.namzu', 'config.yaml'),
			'decision:\n  provider: http\n  url: http://x:1\n  apiKeyEnv: K\n',
		)
		expect(load(opts).decision).toEqual({ provider: 'http', url: 'http://x:1', apiKeyEnv: 'K' })
		expect(readUserDecisionSetting(opts)).toBe('block')
	})

	it('cannot be said by a project file', () => {
		const { opts } = scratch()
		writeConnection({ provider: 'http', url: 'http://h:1/x' }, opts)
		const cwd = mkdtempSync(join(tmpdir(), 'cwd-'))
		writeFileSync(join(cwd, 'namzu.config.json'), '{"decision": true}')
		expect(loadConfig({ ...opts, cwd }).decision).toBeUndefined()
	})
})

describe('decisionStatusLine', () => {
	it('says off, not connected, or connected with the points that are on', () => {
		expect(
			decisionStatusLine({ config: undefined, connected: false, env: { NAMZU_NO_DECISION: '1' } }),
		).toBe('Off (NAMZU_NO_DECISION)')
		expect(decisionStatusLine({ config: undefined, connected: false, env: {} })).toBe(
			'Not connected',
		)
		expect(
			decisionStatusLine({
				config: {
					provider: 'http',
					url: 'u',
					points: { notify: 'on', skill: 'off', pick: 'shadow' },
				},
				connected: true,
				env: {},
			}),
		).toBe('Connected · notify on, pick shadow')
	})
})

describe('a key belongs to the connection it was saved with', () => {
	it('is dropped when the next connection is saved without one', () => {
		const { opts } = scratch()
		saveConnection(
			{
				kind: 'azure',
				endpoint: 'https://r.services.ai.azure.com',
				deployment: 'd',
				key: 'old-key-1',
			},
			opts,
		)
		expect(readDecisionKey(opts)).toBe('old-key-1')
		saveConnection({ kind: 'http', url: 'http://127.0.0.1:9/x' }, opts)
		expect(readDecisionKey(opts)).toBeNull()
	})

	it('is read back only for the address it was saved with', () => {
		const { opts } = scratch()
		resetBoundKeyCache()
		saveConnection({ kind: 'http', url: 'http://127.0.0.1:9/x', key: 'k-1' }, opts)
		expect(readBoundDecisionKey('http://127.0.0.1:9/x', opts)).toBe('k-1')
		expect(readBoundDecisionKey('https://elsewhere.example/x', opts)).toBeNull()
	})

	it('is read again after a new key is saved in the same process', () => {
		const { opts } = scratch()
		saveConnection({ kind: 'http', url: 'http://127.0.0.1:9/x', key: 'k-1' }, opts)
		expect(readBoundDecisionKey('http://127.0.0.1:9/x', opts)).toBe('k-1')
		saveConnection({ kind: 'http', url: 'http://127.0.0.1:9/x', key: 'k-2' }, opts)
		expect(readBoundDecisionKey('http://127.0.0.1:9/x', opts)).toBe('k-2')
	})
})

describe('connectedPointsNotice', () => {
	it('says which points act and which only record, for the defaults', () => {
		expect(connectedPointsNotice()).toBe(
			'notify and skill are on; memory and pick only record to the decision log until you set them to on.',
		)
	})
})
