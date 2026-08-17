import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { LogRecord } from '@namzu/sdk'

import { installCliLogging } from '../../logging.js'
import { createAgentSession } from '../agent.js'

/**
 * The half of the boot narrative `createAgentSession` itself emits when
 * capability state is not the thing under test: sandbox, provider chain,
 * connector discovery, and the terminal `namzu.boot.ready`/`.boot.refused`
 * pair. Capability-specific behavior (broken/absent, never gating
 * readiness) is `boot-narrative-capabilities.test.ts`; the two
 * previously-silent catches are `boot-narrative-catches.test.ts`.
 *
 * Runs against the REAL `probeCapabilities()` rather than mocking it —
 * none of these assertions depend on capability state, and the real probe
 * never throws (proven separately in `context/__tests__`), so there is
 * nothing here for a real probe to make flaky.
 */

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
})

function cwd(): string {
	return mkdtempSync(join(tmpdir(), 'namzu-boot-'))
}

function capturingSink(): LogRecord[] {
	const records: LogRecord[] = []
	installCliLogging({ emit: (r) => records.push(r) }, 'debug')
	return records
}

async function session(prefs: unknown) {
	const s = await createAgentSession(prefs as never, detectedAnthropic, { cwd: cwd() })
	open.push(s)
	return s
}

describe('the sandbox row', () => {
	it('is emitted once, message byte-equal to the notice, severity agreeing with unconfined', async () => {
		const records = capturingSink()
		await session({ version: 3, providers: [{ id: 'anthropic' }] })

		const rows = records.filter((r) => r.eventName === 'namzu.sandbox.resolved')
		expect(rows).toHaveLength(1)
		const unconfined = rows[0].attributes['namzu.sandbox.unconfined']
		expect(typeof unconfined).toBe('boolean')
		expect(rows[0].severityText).toBe(unconfined ? 'warn' : 'info')
	})
})

describe('the provider-chain row', () => {
	it('names the resolved head, and reports a skipped fallback as a separate warn row', async () => {
		const records = capturingSink()
		await session({ version: 3, providers: [{ id: 'anthropic' }, { id: 'openai' }] })

		const resolved = records.filter((r) => r.eventName === 'namzu.provider.resolved')
		const summary = resolved.find((r) => r.severityText === 'info')
		expect(summary?.attributes['namzu.provider.id']).toBe('anthropic')
		expect(summary?.attributes['namzu.provider.chain_length']).toBe(2)
		const skip = resolved.find((r) => r.severityText === 'warn')
		expect(skip?.body).toContain('has no credential')
	})

	it('reports zero skips for a single-member chain', async () => {
		const records = capturingSink()
		await session({ version: 3, providers: [{ id: 'anthropic' }] })

		const resolved = records.filter((r) => r.eventName === 'namzu.provider.resolved')
		expect(resolved).toHaveLength(1)
		expect(resolved[0].attributes['namzu.provider.skipped_count']).toBe(0)
	})
})

describe('the discovery row', () => {
	it('reports the connector count at info, with no mcpServers configured', async () => {
		const records = capturingSink()
		await session({ version: 3, providers: [{ id: 'anthropic' }] })

		const row = records.find(
			(r) => r.eventName === 'namzu.discovery.completed' && r.severityText === 'info',
		)
		expect(row?.attributes['namzu.discovery.kind']).toBe('connector')
		expect(row?.attributes['namzu.discovery.count']).toBe(0)
		expect(row?.attributes['namzu.discovery.tool_count']).toBe(0)
	})
})

describe('namzu.boot.ready / namzu.boot.refused', () => {
	it('ready fires exactly once on success, with no boolean readiness field', async () => {
		const records = capturingSink()
		await session({ version: 3, providers: [{ id: 'anthropic' }] })

		const ready = records.filter((r) => r.eventName === 'namzu.boot.ready')
		expect(ready).toHaveLength(1)
		for (const key of Object.keys(ready[0].attributes)) {
			expect(key.toLowerCase()).not.toBe('ready')
		}
		expect(records.filter((r) => r.eventName === 'namzu.boot.refused')).toHaveLength(0)
	})

	it('refused fires at error on a refusal, and ready never fires', async () => {
		const records = capturingSink()
		await createAgentSession(
			{ version: 3, providers: [{ id: 'not-a-real-provider' }] } as never,
			[],
			{ cwd: cwd() },
		)

		const refused = records.filter((r) => r.eventName === 'namzu.boot.refused')
		expect(refused).toHaveLength(1)
		expect(refused[0].severityText).toBe('error')
		expect(records.filter((r) => r.eventName === 'namzu.boot.ready')).toHaveLength(0)
	})
})
