import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { generateMessageId, generateSessionId, generateTenantId, generateTurnId } from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { runWatch } from '../../commands/watch.js'
import { type LogHome, SLUG, logHome, settlement } from '../subagents/__fixtures__/session-logs.js'
import { ChangeWaiter } from './watch-wait.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

/**
 * The writer of a session lives in another process, as it does for a real
 * terminal. It appends one step each time it is told to, and says so when the
 * bytes are on disk; this process follows the log with the real file watcher.
 * Nothing waits for a duration: each side waits for the other's words.
 */
const WRITER = `
const sdk = await import(process.argv[1])
const cfg = JSON.parse(process.argv[2])
const log = new sdk.DiskSessionLog({ sessionId: cfg.sessionId, file: cfg.file, sessionDir: cfg.sessionDir })
const lease = await log.claim({ holder: 'writer-process', ttlMs: 300000 })
const say = (line) => process.stdout.write(line + '\\n')
const message = (role, text, kind) => ({
	type: 'message', turnId: cfg.turnId, messageId: role === 'user' ? cfg.userMessageId : cfg.stepMessageId,
	role, ...(kind ? { kind } : {}), content: { role, content: text },
})
await log.append(lease, {
	type: 'session_started', projectId: cfg.projectId, tenantId: cfg.tenantId, cwd: '/work/replay',
	agent: { id: 'namzu', name: 'namzu' },
})
await log.beginTurn(lease, { turnId: cfg.turnId, userMessageId: cfg.userMessageId, config: { model: 'a-model', tokenBudget: 0, timeoutMs: 0 } })
await log.append(lease, message('user', 'Check the release', 'prompt'))
say('started')
const lines = (await import('node:readline')).createInterface({ input: process.stdin })
for await (const line of lines) {
	if (line === 'step') {
		await log.append(lease, message('assistant', 'The second step.'))
		say('stepped')
	} else if (line === 'end') {
		await log.append(lease, { type: 'turn_completed', turnId: cfg.turnId, result: 'ok', stopReason: 'end_turn', settlement: cfg.settlement })
		await log.release(lease)
		say('ended')
		break
	}
}
`

it('follows a log that another process is writing, step by step, until it ends', async () => {
	const h: LogHome = await logHome()
	roots.push(h.root)
	mkdirSync(h.paths.projectDir(), { recursive: true })
	writeFileSync(
		h.paths.projectFile(),
		JSON.stringify({
			v: 1,
			kind: 'project',
			projectId: h.projectId,
			cwd: '/work/replay',
			slug: SLUG,
			createdAt: new Date(0).toISOString(),
		}),
	)
	const sessionId = generateSessionId()
	const tenantId = generateTenantId()
	const cfg = {
		sessionId,
		file: h.paths.sessionLog({ sessionId }),
		sessionDir: h.paths.sessionDir({ sessionId }),
		projectId: h.projectId,
		tenantId,
		turnId: generateTurnId(),
		userMessageId: generateMessageId(),
		stepMessageId: generateMessageId(),
		settlement: settlement('completed', 1),
	}
	const child = spawn(
		process.execPath,
		['--input-type=module', '-e', WRITER, import.meta.resolve('@namzu/sdk'), JSON.stringify(cfg)],
		{ stdio: ['pipe', 'pipe', 'inherit'] },
	)
	const said: string[] = []
	const wakers: Array<() => void> = []
	createInterface({ input: child.stdout }).on('line', (line) => {
		said.push(line)
		for (const wake of wakers.splice(0)) wake()
	})
	const childSaid = async (line: string): Promise<void> => {
		while (!said.includes(line)) await new Promise<void>((resolve) => wakers.push(resolve))
	}

	let shown = ''
	const shownWakers: Array<() => void> = []
	const watcherShows = async (text: string): Promise<void> => {
		while (!shown.includes(text)) await new Promise<void>((resolve) => shownWakers.push(resolve))
	}
	try {
		await childSaid('started')
		const controller = new AbortController()
		const watching = runWatch(
			{ session: sessionId, exitOnEnd: true, plain: true },
			{
				root: h.home,
				tenantId,
				currentSlug: SLUG,
				cwd: '/work/replay',
				write: (text) => {
					shown += text
					for (const wake of shownWakers.splice(0)) wake()
				},
				writeError: () => undefined,
				plain: true,
				columns: 80,
				interactive: false,
				signal: controller.signal,
				makeWaiter: (target) =>
					new ChangeWaiter({
						targets: [
							{ dir: target.paths.projectDir(), name: `${target.sessionId}.jsonl` },
							{ dir: target.paths.sessionDir({ sessionId: target.sessionId }) },
						],
					}),
			},
		)

		// What was written before the watcher looked is shown, and it says it is running.
		await watcherShows('Check the release')
		await watcherShows('running: A turn is running.')
		expect(shown).not.toContain('The second step.')

		// A step another process appends now reaches the watcher.
		child.stdin.write('step\n')
		await childSaid('stepped')
		await watcherShows('The second step.')

		// The writer ends its turn and lets go; the watcher says so and leaves with 0.
		child.stdin.write('end\n')
		await childSaid('ended')
		expect(await watching).toBe(0)
		expect(shown).toContain('finished: The last turn finished.')
	} finally {
		child.kill()
	}
}, 60_000)
