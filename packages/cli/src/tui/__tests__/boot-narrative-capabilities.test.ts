import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LogRecord } from '@namzu/sdk'

import {
	type CapabilityProbe,
	NAMZU_OPTIONAL_CAPABILITIES,
	probeCapabilities,
} from '../../context/capabilities.js'
import { installCliLogging } from '../../logging.js'
import { createAgentSession } from '../agent.js'

vi.mock('../../context/capabilities.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../context/capabilities.js')>()
	return { ...actual, probeCapabilities: vi.fn(actual.probeCapabilities) }
})

const detectedAnthropic = [
	{
		entry: {
			id: 'anthropic',
			label: 'Anthropic',
			defaultModel: 'a-model',
			requiresApiKey: true,
			envVars: ['ANTHROPIC_API_KEY'],
		},
		source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
] as never

const open: { close: () => Promise<void> }[] = []

afterEach(async () => {
	for (const session of open.splice(0)) await session.close()
	vi.mocked(probeCapabilities).mockClear()
})

function cwd(): string {
	return mkdtempSync(join(tmpdir(), 'namzu-boot-cap-'))
}

function capturingSink(): LogRecord[] {
	const records: LogRecord[] = []
	installCliLogging({ emit: (r) => records.push(r) }, 'debug')
	return records
}

async function session() {
	const s = await createAgentSession(
		{ version: 3, providers: [{ id: 'anthropic' }] } as never,
		detectedAnthropic,
		{ cwd: cwd() },
	)
	open.push(s)
	return s
}

describe('a broken optional capability', () => {
	it('reports namzu.capability.broken at error, and never gates namzu.boot.ready', async () => {
		const probes: CapabilityProbe[] = [
			{
				state: 'broken',
				specifier: '@namzu/sandbox',
				error: new TypeError('native binding failed to load'),
			},
			{ state: 'absent', specifier: '@namzu/files' },
			{ state: 'absent', specifier: '@namzu/computer-use' },
			{ state: 'absent', specifier: '@namzu/telemetry' },
		]
		vi.mocked(probeCapabilities).mockResolvedValueOnce(probes)

		const records = capturingSink()
		await session()

		const broken = records.find((r) => r.eventName === 'namzu.capability.broken')
		expect(broken?.severityText).toBe('error')
		expect(broken?.attributes['exception.type']).toBe('TypeError')
		expect(broken?.attributes['exception.message']).toBe('native binding failed to load')
		expect(broken?.attributes['namzu.capability.name']).toBe('@namzu/sandbox')

		expect(records.filter((r) => r.eventName === 'namzu.boot.ready')).toHaveLength(1)
		expect(records.filter((r) => r.eventName === 'namzu.boot.refused')).toHaveLength(0)
	})
})

describe('four absent optional capabilities', () => {
	it('emits namzu.boot.ready exactly once and no capability record above info', async () => {
		const probes: CapabilityProbe[] = NAMZU_OPTIONAL_CAPABILITIES.map((specifier) => ({
			state: 'absent' as const,
			specifier,
		}))
		vi.mocked(probeCapabilities).mockResolvedValueOnce(probes)

		const records = capturingSink()
		await session()

		const capabilityRows = records.filter((r) => r.eventName?.startsWith('namzu.capability.'))
		expect(capabilityRows.length).toBeGreaterThan(0)
		expect(
			capabilityRows.some((r) => r.severityText === 'warn' || r.severityText === 'error'),
		).toBe(false)
		expect(records.filter((r) => r.eventName === 'namzu.boot.ready')).toHaveLength(1)
	})
})
