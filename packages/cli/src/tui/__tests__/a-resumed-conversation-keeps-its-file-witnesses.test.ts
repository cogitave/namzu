/**
 * A conversation picked back up used to start blind about its own files.
 *
 * The observation ledger is a `Map<SessionId, …>` that lives as long as the
 * process, and every way of picking a conversation back up hands it a session
 * id it has never seen. So the first turn after a resume got an empty ledger,
 * the derived work context could admit nothing, and the agent read back a file
 * whose whole body was in the transcript it had just been given.
 *
 * All three ways travel one closure. The TUI's `/resume` sends the messages it
 * reloaded; `namzu run --resume`/`--continue` sends
 * `[...prior, userMessage]` (`commands/run.ts`), and so does
 * `namzu run-stream --session <id>` (`commands/run-stream.ts`) — which are the
 * two headless entry points, because a plain `namzu run` persists no turn at
 * all and therefore has nothing to resume from. That shape is what the first
 * case below sends: restored history with this turn's prompt on the end.
 *
 * These drive the real session through a stubbed transport, because the thing
 * under test is a closure inside `createAgentSession`: which ledger a turn is
 * given, and how many times it is allowed to be rebuilt.
 */

import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	type Message,
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { type SessionScope, createAgentSession } from '../agent.js'

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'deepseek' }],
	subagents: { active: [] },
}
const detected: DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY.deepseek,
		source: { kind: 'env', envName: 'DEEPSEEK_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
]

let cwd: string
let requests: string[]

function done(): Response {
	const chunk = {
		id: 'chatcmpl-file-witness-fixture',
		object: 'chat.completion.chunk',
		created: 1,
		model: 'deepseek-chat',
		choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }],
		usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
	}
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	})
}

/** The history a resumed conversation arrives with: one full write, answered. */
function wrote(callId: string, path: string, content: string): Message[] {
	return [
		createUserMessage(`write ${path}`),
		createAssistantMessage('writing', [
			{
				id: callId,
				type: 'function',
				function: { name: 'write', arguments: JSON.stringify({ path, content }) },
			},
		]),
		createToolMessage(`Created ${path}`, callId),
	]
}

async function open(scope: SessionScope) {
	const session = await createAgentSession(preferences, detected, {
		cwd,
		scope,
		sandbox: { enabled: false },
		plugins: { enabled: false },
		memory: { recall: false },
		limits: { maxIterations: 2 },
	})
	expect(session.hasProvider, session.errorHint ?? undefined).toBe(true)
	return session
}

/**
 * The derived work context of one captured request, and nothing else.
 *
 * The request carries the transcript too, so a call id searched for in the
 * whole body would be found in the assistant message that made the call —
 * which proves nothing about what the ledger established.
 */
function evidenceIn(index: number): string {
	const body = JSON.parse(requests[index] ?? '{}') as {
		messages?: { content?: unknown }[]
	}
	return (body.messages ?? [])
		.map((message) => String(message.content ?? ''))
		.filter((content) => content.includes('Visible file evidence'))
		.join('\n')
}

async function turn(session: Awaited<ReturnType<typeof open>>, messages: Message[]): Promise<void> {
	for await (const _ of session.send(messages)) {
		// Drain the real turn through the stubbed transport.
	}
}

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'namzu-resumed-witness-'))
	requests = []
	await mkdir(join(cwd, '.namzu'))
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async (_input, init) => {
			requests.push(String(init?.body))
			return done()
		}),
	)
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	removeTempDir(cwd)
})

describe('a conversation picked back up keeps the witnesses it earned', () => {
	it('offers the restored body on the very first turn after a resume', async () => {
		const scope: SessionScope = {
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			projectId: generateProjectId(),
			tenantId: generateTenantId(),
		}
		const session = await open(scope)
		try {
			// Exactly what `namzu run --resume` and `run-stream --session` send:
			// the conversation as it was loaded back, with this turn's prompt on
			// the end. The seeding has to read the history it was handed rather
			// than the last message of it.
			await turn(session, [
				...wrote('w1', 'note.txt', 'alpha\nbeta\n'),
				createUserMessage('now change the second line'),
			])
		} finally {
			await session.close()
		}
		expect(requests).toHaveLength(1)
		expect(evidenceIn(0)).toContain('"bodyInCall":"w1"')
		expect(evidenceIn(0)).toContain('note.txt')
	})

	it('seeds once per conversation, so a later turn cannot roll the ledger back', async () => {
		// The hazard the once-only rule exists for. By the second turn the
		// history has moved on — here with a write this process never ran — and
		// a ledger rebuilt from it every turn would adopt that call's body as
		// the runtime's own observation, then refuse the next real mutation for
		// drift against a file nothing wrote.
		const scope: SessionScope = {
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			projectId: generateProjectId(),
			tenantId: generateTenantId(),
		}
		const session = await open(scope)
		const first = wrote('w1', 'note.txt', 'alpha\nbeta\n')
		try {
			await turn(session, first)
			await turn(session, [
				...first,
				...wrote('w2', 'note.txt', 'a body this process never wrote\n'),
			])
		} finally {
			await session.close()
		}
		expect(requests).toHaveLength(2)
		expect(evidenceIn(1)).toContain('"bodyInCall":"w1"')
		expect(evidenceIn(1)).not.toContain('"bodyInCall":"w2"')
	})

	it('gives a second conversation in the same process its own seeding', async () => {
		// `/resume` mutates the session id on the scope object the session
		// closed over, so both conversations are served by one map — and the
		// second must be seeded from its own messages, never the first's.
		const scope: SessionScope = {
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			projectId: generateProjectId(),
			tenantId: generateTenantId(),
		}
		const session = await open(scope)
		try {
			await turn(session, wrote('w1', 'first.txt', 'first conversation\n'))
			scope.sessionId = generateSessionId()
			await turn(session, wrote('w2', 'second.txt', 'second conversation\n'))
		} finally {
			await session.close()
		}
		expect(requests).toHaveLength(2)
		expect(evidenceIn(0)).toContain('first.txt')
		expect(evidenceIn(1)).toContain('"bodyInCall":"w2"')
		expect(evidenceIn(1)).toContain('second.txt')
		expect(evidenceIn(1)).not.toContain('first.txt')
	})
})
