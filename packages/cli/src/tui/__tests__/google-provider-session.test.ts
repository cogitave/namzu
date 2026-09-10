/** Native Gemini transport reaches the real CLI session and its read-only tool loop. */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/index.js'
import { type AgentEvent, createAgentSession } from '../agent.js'

let cwd: string | undefined
afterEach(() => {
	vi.unstubAllGlobals()
	if (cwd) removeTempDir(cwd)
})

it('executes a requested file read and returns its result with native signed history', async () => {
	cwd = await mkdtemp(join(tmpdir(), 'namzu-gemini-session-'))
	const path = join(cwd, 'witness.txt')
	await writeFile(path, 'GEMINI_READ_WITNESS')
	const bodies: unknown[] = []
	const network = vi.fn<typeof fetch>(async (input, init) => {
		expect(String(input)).toContain(
			'generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent',
		)
		const body: unknown = JSON.parse(String(init?.body))
		bodies.push(body)
		const parts =
			bodies.length === 1
				? [
						{
							functionCall: { name: 'read', args: { path } },
							thoughtSignature: 'fixture-signature',
						},
					]
				: [{ text: 'Read complete: GEMINI_READ_WITNESS' }]
		return new Response(
			`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } })}\n\n`,
			{ headers: { 'content-type': 'text/event-stream' } },
		)
	})
	vi.stubGlobal('fetch', network)
	const session = await createAgentSession(
		{
			version: 3,
			providers: [{ id: 'google', model: 'gemini-2.5-flash' }],
			subagents: { active: [] },
		},
		[
			{
				entry: PROVIDER_REGISTRY.google,
				source: { kind: 'session' },
				apiKey: 'fixture-api-key',
				alternatives: [],
			},
		],
		{ cwd },
	)
	const events: AgentEvent[] = []
	try {
		expect(session.hasProvider, session.errorHint ?? '').toBe(true)
		for await (const event of session.send([
			createUserMessage('Read witness.txt and report its contents.'),
		]))
			events.push(event)
	} finally {
		await session.close()
	}
	expect(events.filter((e) => e.kind === 'error')).toEqual([])
	expect(bodies).toHaveLength(2)
	expect(JSON.stringify(bodies[1])).toContain('GEMINI_READ_WITNESS')
	expect(JSON.stringify(bodies[1])).toContain('fixture-signature')
	expect(events.some((e) => e.kind === 'delta' && e.text.includes('Read complete'))).toBe(true)
})
