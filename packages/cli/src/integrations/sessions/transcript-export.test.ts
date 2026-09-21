import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Message, createUserMessage, generateMessageId } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { recordTurn } from '../../__fixtures__/session-log.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	conversationLogPath,
	forkConversation,
	openConversationLog,
	openSessions,
	readConversationFacts,
	refreshIndex,
	startConversation,
} from './store.js'
import { conversationMarkdown, writeConversationExport } from './transcript-export.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

async function temp(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix))
	dirs.push(dir)
	return dir
}

async function project() {
	return openSessions(await temp('namzu-export-workspace-'), {
		stateRoot: await temp('namzu-export-home-'),
	})
}

function assistant(content: string, extra: Record<string, unknown> = {}): Message {
	return { role: 'assistant', content, ...extra } as Message
}

describe('exporting a conversation from its session log', () => {
	it('renders each turn: the prompt, the answer and the tool activity between them', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [
			createUserMessage('list the files'),
			assistant('', {
				toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'ls', arguments: '{}' } }],
			}),
			{ role: 'tool', toolCallId: 'call-1', content: 'a.ts\nb.ts' } as Message,
			assistant('There are two files.'),
		])

		const exported = await conversationMarkdown(s, id)

		expect(exported.turns).toBe(1)
		expect(exported.markdown).toContain(`Conversation: \`${id}\``)
		expect(exported.markdown).toContain('## User\n\nlist the files')
		expect(exported.markdown).toContain('Tool started: `ls`')
		expect(exported.markdown).toContain('Tool result for `call-1`')
		expect(exported.markdown).toContain('## Assistant\n\nThere are two files.')
	})

	it('shows an answer the runtime replaced, never the raw one', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [createUserMessage('what is the key'), assistant('the key is SECRET')])
		const facts = await readConversationFacts(s, id)
		const answer = facts?.records.find(
			(record) => record.type === 'message' && record.role === 'assistant',
		)
		if (answer?.type !== 'message') throw new Error('fixture expected the assistant record')
		const log = openConversationLog(s, id)
		const lease = await log.claim({ holder: 'test-replacement', ttlMs: 10_000 })
		if (!lease) throw new Error('fixture could not lease the log')
		await log.append(lease, {
			type: 'message_replaced',
			targetMessageId: answer.messageId,
			content: assistant('the key is [redacted]'),
			reason: 'guardrail_rewritten',
		})
		await log.release(lease)
		await refreshIndex(s, id)

		const exported = await conversationMarkdown(s, id)

		expect(exported.markdown).toContain('the key is [redacted]')
		expect(exported.markdown).not.toContain('SECRET')
	})

	it('names how a turn ended when it did not end normally', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [createUserMessage('first')], { status: 'failed', result: 'boom' })
		await recordTurn(s, id, [createUserMessage('second')], { status: 'cancelled' })

		const exported = await conversationMarkdown(s, id)

		expect(exported.turns).toBe(2)
		expect(exported.markdown).toContain('Turn failed: boom')
		expect(exported.markdown).toContain('Turn stopped: cancelled.')
	})

	it('includes the history a fork copied', async () => {
		const s = await project()
		const source = await startConversation(s)
		await recordTurn(s, source, [
			createUserMessage('the original question'),
			assistant('an answer'),
		])
		const fork = await forkConversation(s, source)
		await recordTurn(s, fork.id, [createUserMessage('a follow-up in the fork')])

		const exported = await conversationMarkdown(s, fork.id)

		expect(exported.markdown).toContain('## Copied history')
		expect(exported.markdown).toContain('the original question')
		expect(exported.markdown).toContain('a follow-up in the fork')
		// The copied prompt is a turn of the fork, and so is its own.
		expect(exported.turns).toBe(2)
	})

	it('refuses a log whose hash chain is broken', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [createUserMessage('tamper with me'), assistant('original')])
		const path = conversationLogPath(s, id)
		writeFileSync(path, readFileSync(path, 'utf8').replace('original', 'forged!!'))

		await expect(conversationMarkdown(s, id)).rejects.toMatchObject({ reason: 'log-unreadable' })
	})

	it('refuses a conversation with nothing to export, and one of another project', async () => {
		const s = await project()
		const empty = await startConversation(s)
		const other = await openSessions(await temp('namzu-export-other-'), { stateRoot: s.root })
		const foreign = await startConversation(other)
		await recordTurn(other, foreign, [createUserMessage('not yours')])

		await expect(conversationMarkdown(s, empty)).rejects.toMatchObject({
			reason: 'nothing-to-export',
		})
		await expect(conversationMarkdown(s, foreign)).rejects.toMatchObject({ reason: 'not-found' })
	})

	it('reports a turn that has not settled instead of guessing its end', async () => {
		const s = await project()
		const id = await startConversation(s)
		const log = openConversationLog(s, id)
		const lease = await log.claim({ holder: 'test-open-turn', ttlMs: 10_000 })
		if (!lease) throw new Error('fixture could not lease the log')
		const userMessageId = generateMessageId()
		const started = await log.beginTurn(lease, {
			turnId: '019a0000-0000-7000-8000-00000000000a' as never,
			userMessageId,
			config: { model: 'test-model', tokenBudget: 1, timeoutMs: 1 },
		})
		await log.append(lease, {
			type: 'message',
			turnId: started.record.turnId as never,
			messageId: userMessageId,
			role: 'user',
			kind: 'prompt',
			content: createUserMessage('still going'),
		})
		await log.release(lease)

		const exported = await conversationMarkdown(s, id)

		expect(exported.markdown).toContain('still going')
		expect(exported.markdown).toContain('has not settled')
	})
})

describe('writing an export', () => {
	it('never overwrites an existing file', async () => {
		const root = await temp('namzu-export-target-')
		const target = join(root, 'conversation.md')

		const first = await writeConversationExport('# one\n', target, root)
		expect(first.path).toBe(target)
		expect(await readFile(target, 'utf-8')).toBe('# one\n')
		await expect(writeConversationExport('# two\n', target, root)).rejects.toThrow(
			/nothing was overwritten/,
		)
		expect(await readFile(target, 'utf-8')).toBe('# one\n')
	})
})
