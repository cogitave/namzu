import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DiskSessionLog,
	MockLLMProvider,
	asSessionId,
	createUserMessage,
	drainQuery,
	generateSessionId,
} from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import * as sessionStorage from '../../integrations/sessions/store.js'
import {
	closeSessions,
	openSessions,
	readConversationFacts,
	startConversation,
} from '../../integrations/sessions/store.js'
import { decideHeadlessTrust } from '../../permissions/headless-trust.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'
import {
	GIT_CACHE_MS,
	type GitRun,
	capMarkdown,
	createProjectGit,
	runGit,
} from '../desktop-host-header.js'
import { createDesktopHostExtensions } from '../desktop-host.js'

let root: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-desktop-header-'))
	cwd = join(root, 'project')
	mkdirSync(join(cwd, '.git'), { recursive: true })
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

function runtime() {
	return createCliAcpRuntime(
		{
			config: {},
			formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} },
		},
		{
			decideTrust: decideHeadlessTrust,
			resolveSession: async (sessionId: string) => ({ sessionId }),
		} as unknown as AcpRuntimeDependencies,
	)
}

async function seeded(prompt = 'Stored request', turn = true) {
	const state = await openSessions(cwd)
	const sessionId = await startConversation(state)
	if (turn)
		await drainQuery({
			provider: new MockLLMProvider({ responseText: 'Stored answer' }),
			messages: [createUserMessage(prompt)],
			toolsets: [],
			agentId: 'fixture',
			agentName: 'Fixture',
			sessionLog: DiskSessionLog.at(state.paths, { sessionId }),
			sessionId,
			tenantId: state.tenantId,
			projectId: state.projectId,
			topicId: state.topicId,
			workingDirectory: cwd,
			turnConfig: { model: 'mock', maxIterations: 2, tokenBudget: 100_000, timeoutMs: 30_000 },
		})
	return { state, sessionId }
}

const fakeGit = (run: GitRun) => createProjectGit({ run })

describe('conversation header ACP methods', () => {
	it('refuses every method until the folder is trusted, and git answers null', async () => {
		const owner = runtime()
		const git = vi.fn<GitRun>(async () => 'main\n')
		const host = createDesktopHostExtensions(owner, cwd, undefined, undefined, fakeGit(git))
		const id = generateSessionId()
		try {
			await expect(
				host['namzu/conversations/rename']({ sessionId: id, title: 'x' }),
			).rejects.toThrow('Trust this folder')
			await expect(host['namzu/conversations/fork']({ sessionId: id })).rejects.toThrow(
				'Trust this folder',
			)
			await expect(host['namzu/conversations/markdown']({ sessionId: id })).rejects.toThrow(
				'Trust this folder',
			)
			expect(await host['namzu/project/git']({})).toBeNull()
			expect(git).not.toHaveBeenCalled()
		} finally {
			await owner.close()
		}
	})

	it('refuses a conversation this project does not own', async () => {
		const owner = runtime()
		const host = createDesktopHostExtensions(owner, cwd)
		host['namzu/project/trust']({ confirmed: true, cwd })
		const id = generateSessionId()
		try {
			await expect(
				host['namzu/conversations/rename']({ sessionId: id, title: 'x' }),
			).rejects.toThrow('does not belong')
			await expect(host['namzu/conversations/fork']({ sessionId: id })).rejects.toThrow(
				'does not belong',
			)
			await expect(host['namzu/conversations/markdown']({ sessionId: id })).rejects.toThrow(
				'does not belong',
			)
			await expect(
				host['namzu/conversations/rename']({ sessionId: id, title: 'x', extra: 1 }),
			).rejects.toThrow('Invalid')
		} finally {
			await owner.close()
		}
	})

	it('renames, and an empty title restores the derived one', async () => {
		const owner = runtime()
		const host = createDesktopHostExtensions(owner, cwd)
		host['namzu/project/trust']({ confirmed: true, cwd })
		const { state, sessionId } = await seeded('Derive me from this')
		try {
			expect(
				await host['namzu/conversations/rename']({ sessionId, title: '  Chosen name  ' }),
			).toEqual({
				title: 'Chosen name',
			})
			const facts = await readConversationFacts(state, asSessionId(sessionId))
			expect(facts?.named).toBe(true)
			expect(await host['namzu/conversations/rename']({ sessionId, title: '' })).toEqual({
				title: 'Derive me from this',
			})
			expect((await readConversationFacts(state, asSessionId(sessionId)))?.named).toBe(false)
		} finally {
			closeSessions(state)
			await owner.close()
		}
	})

	it('forks a settled conversation into a new owned one', async () => {
		const owner = runtime()
		const host = createDesktopHostExtensions(owner, cwd)
		host['namzu/project/trust']({ confirmed: true, cwd })
		const { state, sessionId } = await seeded()
		try {
			const fork = (await host['namzu/conversations/fork']({ sessionId })) as {
				id: string
				title: string
			}
			expect(fork.id).not.toBe(sessionId)
			expect(fork.title).toContain('(fork')
			const md = await host['namzu/conversations/markdown']({ sessionId: fork.id })
			expect(md.markdown).toContain('Stored request')
		} finally {
			closeSessions(state)
			await owner.close()
		}
	})

	it('refuses to fork while a turn runs and when the conversation is empty', async () => {
		const owner = runtime()
		const host = createDesktopHostExtensions(owner, cwd)
		host['namzu/project/trust']({ confirmed: true, cwd })
		const { state, sessionId } = await seeded()
		const empty = await seeded('', false)
		try {
			const actual = sessionStorage.readConversationFacts
			vi.spyOn(sessionStorage, 'readConversationFacts').mockImplementation(async (...args) => {
				const facts = await actual(...args)
				return facts && args[1] === sessionId
					? { ...facts, activeTurn: { turnId: 't', paused: false } }
					: facts
			})
			await expect(host['namzu/conversations/fork']({ sessionId })).rejects.toThrow(
				'Wait for the current reply',
			)
			await expect(
				host['namzu/conversations/fork']({ sessionId: empty.sessionId }),
			).rejects.toThrow('nothing to fork')
		} finally {
			closeSessions(state)
			closeSessions(empty.state)
			await owner.close()
		}
	})

	it('exports Markdown without the truncation flag when it fits', async () => {
		const owner = runtime()
		const host = createDesktopHostExtensions(owner, cwd)
		host['namzu/project/trust']({ confirmed: true, cwd })
		const { state, sessionId } = await seeded()
		try {
			const out = await host['namzu/conversations/markdown']({ sessionId })
			expect(out.truncated).toBe(false)
			expect(out.markdown).toContain('Stored answer')
		} finally {
			closeSessions(state)
			await owner.close()
		}
	})

	it('reads git only in a trusted folder and caches the answer', async () => {
		const owner = runtime()
		const git = vi.fn<GitRun>(async (args) => (args[0] === 'symbolic-ref' ? 'main\n' : 'Fix it\n'))
		const host = createDesktopHostExtensions(owner, cwd, undefined, undefined, fakeGit(git))
		host['namzu/project/trust']({ confirmed: true, cwd })
		try {
			expect(await host['namzu/project/git']({})).toEqual({ branch: 'main', subject: 'Fix it' })
			expect(await host['namzu/project/git']({})).toEqual({ branch: 'main', subject: 'Fix it' })
			expect(git).toHaveBeenCalledTimes(2)
		} finally {
			await owner.close()
		}
	})
})

describe('project git reader', () => {
	const failure = (code: unknown, extra: object = {}) =>
		Object.assign(new Error('git'), { code, ...extra })

	it('reports a detached HEAD as a null branch with the commit subject', async () => {
		const read = fakeGit(async (args) => {
			if (args[0] === 'symbolic-ref') throw failure(1)
			return 'Detached subject\n'
		})
		expect(await read('/p')).toEqual({ branch: null, subject: 'Detached subject' })
	})

	it('returns null for a non-repository, a missing git and a timeout', async () => {
		for (const error of [
			failure(128),
			failure('ENOENT'),
			failure(null, { killed: true, signal: 'SIGTERM' }),
		]) {
			expect(
				await fakeGit(async () => {
					throw error
				})('/p'),
			).toBeNull()
		}
	})

	it('keeps the branch when an unborn branch has no commit yet', async () => {
		const read = fakeGit(async (args) => {
			if (args[0] === 'symbolic-ref') return 'main\n'
			throw failure(128)
		})
		expect(await read('/p')).toEqual({ branch: 'main', subject: null })
	})

	it('serves a cached answer until the window passes, per folder', async () => {
		let clock = 1_000
		const run = vi.fn<GitRun>(async (args) => (args[0] === 'symbolic-ref' ? 'a\n' : 's\n'))
		const read = createProjectGit({ run, now: () => clock })
		await read('/p')
		clock += GIT_CACHE_MS - 1
		await read('/p')
		expect(run).toHaveBeenCalledTimes(2)
		await read('/q')
		expect(run).toHaveBeenCalledTimes(4)
		clock += 1
		await read('/p')
		expect(run).toHaveBeenCalledTimes(6)
	})

	it('truncates a long subject', async () => {
		const read = fakeGit(async (args) => (args[0] === 'symbolic-ref' ? 'a\n' : 'x'.repeat(500)))
		expect((await read('/p'))?.subject).toHaveLength(200)
	})

	it('answers null for a real folder that is not a repository', async () => {
		const bare = mkdtempSync(join(root, 'bare-'))
		expect(await createProjectGit({ run: runGit })(bare)).toBeNull()
	})
})

describe('capMarkdown', () => {
	it('leaves small text alone', () => {
		expect(capMarkdown('hello', 10)).toEqual({ markdown: 'hello', truncated: false })
	})
	it('cuts on a character boundary and flags it', () => {
		// 'é' is two bytes: a cap of 5 bytes must not leave half of the third one.
		expect(capMarkdown('ééé', 5)).toEqual({ markdown: 'éé', truncated: true })
		expect(capMarkdown('aaaa', 2)).toEqual({ markdown: 'aa', truncated: true })
	})
})
