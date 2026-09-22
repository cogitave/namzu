/**
 * The CLI's default: tools on the host, under the permission system, with the
 * two boundary crossings put to a person rather than refused or waved
 * through.
 *
 * `query` is replaced so the test sees exactly what a turn is handed — the
 * escalation settings, the sandbox (or its absence), the system prompt, and
 * the review handler — and then drives that real handler with the requests
 * the kernel would send it. The kernel half (that an escalated call is routed
 * here at all, and that an unconfirmed escape is refused) is pinned in the
 * SDK's `an-escalated-call-is-a-question` test.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'

import {
	type HITLDecisionRequest,
	OUTSIDE_ROOTS_UNATTENDED_REFUSAL,
	type ResumeHandler,
	SANDBOX_ESCAPE_UNATTENDED_REFUSAL,
	type ToolCallSummary,
} from '@namzu/sdk'

import type { SandboxConfig } from '../../config/schema.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import { openSessions, startConversation } from '../../integrations/sessions/store.js'
import type { PermissionMode } from '../../permissions/mode.js'
import type { PermissionFn } from '../agent.js'

const queryCalls: Record<string, unknown>[] = []
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Record<string, unknown>) => {
			queryCalls.push(params)
			return (async function* () {})()
		},
	}
})

let workDir: string
let stateRoot: string

beforeEach(() => {
	queryCalls.length = 0
	workDir = mkdtempSync(join(tmpdir(), 'namzu-host-cwd-'))
	stateRoot = mkdtempSync(join(tmpdir(), 'namzu-host-state-'))
})

afterEach(() => {
	removeTempDir(workDir)
	removeTempDir(stateRoot)
})

const prefs = {
	version: 3,
	providers: [{ id: 'anthropic' }],
	subagents: { active: [] },
} as Preferences

const detected = [
	{
		entry: {
			id: 'anthropic',
			label: 'Anthropic',
			defaultModel: 'claude-sonnet-4-5',
			requiresApiKey: true,
			envVars: ['ANTHROPIC_API_KEY'],
		},
		source: 'env',
		apiKey: 'sk-ant-not-a-real-key',
		alternatives: [],
	} as unknown as DetectedProvider,
]

/** One turn's `query` params, sent with or without a person to ask. */
async function turn(input: {
	readonly sandbox?: SandboxConfig
	readonly permissionMode?: PermissionMode
	readonly onPermission?: PermissionFn
}) {
	const { createAgentSession } = await import('../agent.js')
	const sessions = await openSessions(workDir, { stateRoot })
	const session = await createAgentSession(prefs, detected, {
		cwd: workDir,
		stateRoot,
		scope: {
			sessionId: await startConversation(sessions),
			topicId: sessions.topicId,
			projectId: sessions.projectId,
			tenantId: sessions.tenantId,
		},
		...(input.sandbox ? { sandbox: input.sandbox } : {}),
		...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
	})
	try {
		for await (const _ of session.send([{ role: 'user', content: 'go', timestamp: 0 }], {
			...(input.onPermission ? { onPermission: input.onPermission } : {}),
		})) {
			// The query mock captures the params.
		}
	} finally {
		await session.close()
	}
	const params = queryCalls[0] as Record<string, unknown>
	return { params, handler: params.resumeHandler as ResumeHandler }
}

function review(call: ToolCallSummary): HITLDecisionRequest {
	return {
		type: 'tool_review',
		sessionId: 's',
		turnId: 't',
		checkpointId: 'c',
		toolCalls: [call],
	} as unknown as HITLDecisionRequest
}

const outsideRead: ToolCallSummary = {
	id: 'r1',
	name: 'read',
	input: { path: '/mnt/c/Users/me/notes.txt' },
	isDestructive: false,
	authorization: { decision: 'review' },
	escalation: { outsidePaths: ['/mnt/c/Users/me/notes.txt'] },
}

const escapeCall: ToolCallSummary = {
	id: 'b1',
	name: 'bash',
	input: { command: 'curl -sI https://example.com', dangerously_disable_sandbox: true },
	isDestructive: false,
	authorization: { decision: 'review' },
	escalation: { sandboxEscape: true },
}

describe('by default the CLI runs tools on the host', () => {
	it('with no sandbox, and both boundary crossings routed to review', async () => {
		const { params } = await turn({})

		expect(params.sandboxProvider).toBeUndefined()
		expect(params).toMatchObject({ outsideRootAccess: 'review', sandboxEscape: 'review' })
		// The model is told where it runs and how past the edge, up front —
		// here with nobody to ask, so the edge is a refusal and `--add-dir`.
		expect(String(params.systemPrompt)).toMatch(/not in a sandbox/)
		expect(String(params.systemPrompt)).toMatch(/A path anywhere else is refused in this session/)
	})

	it('refuses a path outside in a headless turn rather than approving it silently', async () => {
		// A headless turn with no flags resolves to `auto`; that approves
		// ordinary calls, never a path outside the roots.
		const { handler } = await turn({ permissionMode: 'auto' })

		expect(await handler(review(outsideRead))).toEqual({
			action: 'reject_tools',
			feedback: OUTSIDE_ROOTS_UNATTENDED_REFUSAL,
		})
	})

	it('asks about a path outside under --yolo (auto) when a person is there', async () => {
		const onPermission = vi.fn<PermissionFn>(async () => ({ kind: 'reject' }))
		const { handler } = await turn({ permissionMode: 'auto', onPermission })

		expect(await handler(review(outsideRead))).toMatchObject({ action: 'reject_tools' })
		expect(onPermission).toHaveBeenCalledTimes(1)
	})

	it('asks about a path outside after "allow all tools for this session"', async () => {
		const onPermission = vi.fn<PermissionFn>(async () => ({ kind: 'approve-all' }))
		const { handler } = await turn({ onPermission })
		const ordinary: ToolCallSummary = {
			id: 'b0',
			name: 'bash',
			input: { command: 'ls' },
			isDestructive: false,
			authorization: { decision: 'review' },
		}

		expect(await handler(review(ordinary))).toEqual({ action: 'approve_tools' })
		expect(onPermission).toHaveBeenCalledTimes(1)
		expect(await handler(review(outsideRead))).toEqual({ action: 'approve_tools' })
		expect(onPermission).toHaveBeenCalledTimes(2)
	})

	it('asks the person about a read outside the working directory instead of refusing it', async () => {
		const onPermission = vi.fn<PermissionFn>(async () => ({ kind: 'approve' }))
		const { handler } = await turn({ onPermission })

		expect(await handler(review(outsideRead))).toEqual({ action: 'approve_tools' })
		expect(onPermission).toHaveBeenCalledTimes(1)
		expect(onPermission.mock.calls[0]?.[0].toolCalls[0]?.escalation).toEqual({
			outsidePaths: ['/mnt/c/Users/me/notes.txt'],
		})
	})
})

describe('a sandbox escape', () => {
	it('is asked about under --yolo (auto) when a person is there, never approved by the mode', async () => {
		const onPermission = vi.fn<PermissionFn>(async () => ({ kind: 'approve' }))
		const { handler } = await turn({
			sandbox: { enabled: true },
			permissionMode: 'auto',
			onPermission,
		})

		expect(await handler(review(escapeCall))).toEqual({
			action: 'approve_tools',
			confirmedEscalations: ['b1'],
		})
		expect(onPermission).toHaveBeenCalledTimes(1)
	})

	it('is refused in a headless turn, even under --yolo', async () => {
		const { handler, params } = await turn({ sandbox: { enabled: true }, permissionMode: 'auto' })

		expect(await handler(review(escapeCall))).toEqual({
			action: 'reject_tools',
			feedback: SANDBOX_ESCAPE_UNATTENDED_REFUSAL,
		})
		// And the model is told so rather than offered an escape it cannot use.
		expect(String(params.systemPrompt)).toMatch(/cannot leave the sandbox in this session/)
	})

	it('is granted unasked in a headless turn only when the config says so', async () => {
		const { handler } = await turn({
			sandbox: { enabled: true, allowUnattendedEscape: true },
			permissionMode: 'auto',
		})

		expect(await handler(review(escapeCall))).toEqual({
			action: 'approve_tools',
			confirmedEscalations: ['b1'],
		})
	})

	it('is refused outright by the kernel when escapes are turned off', async () => {
		const { params } = await turn({ sandbox: { enabled: true, allowEscape: false } })

		expect(params.sandboxEscape).toBe('refuse')
	})
})
