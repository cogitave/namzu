import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'

// Two separate consumers of the built package and the disk checkpoint store.
// The first process removes feedback to simulate compaction; no in-memory
// counter or message scan can carry the exhausted allowance into the second.
const worker = `
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const sdk = await import(pathToFileURL(process.argv[2]).href)
const root = process.argv[3], mode = process.argv[4]
const stateFile = join(root, 'state.json')
const state = mode === 'resume' ? JSON.parse(await readFile(stateFile, 'utf8')) : {
  turnId: sdk.generateTurnId(), sessionId: sdk.generateSessionId(),
  projectId: sdk.generateProjectId(), tenantId: sdk.generateTenantId(), topicId: sdk.generateTopicId(),
}
const store = new sdk.DiskCheckpointStore({ baseDir: join(root, 'runs') })
const provider = new sdk.MockLLMProvider({ turns: [{ text: 'Unverified.' }] })
const run = await sdk.drainQuery({
  ...state, provider, checkpointStore: store, tools: new sdk.ToolRegistry(),
  agentId: 'review-restart', agentName: 'Review restart', workingDirectory: root,
  messages: [sdk.createUserMessage('Give a verified answer.')],
  turnConfig: { model: 'mock', tokenBudget: 10000, maxIterations: 5, timeoutMs: 10000 },
  maxAnswerReviews: 0, reviewAnswer: () => ({ accept: false, feedback: 'Evidence mismatch.' }),
  ...(mode === 'resume' ? { resumeFromCheckpoint: state.checkpointId } : {}),
})
if (mode === 'seed') {
  const cp = (await store.listCheckpoints(state)).find(c => c.answerReviewAttempts === 1)
  if (!cp) throw new Error('Missing durable review rejection')
  await store.writeCheckpoint(state, { ...cp, messages: [sdk.createUserMessage('Compacted summary.')] })
  await writeFile(stateFile, JSON.stringify({ ...state, checkpointId: cp.id }))
}
console.log(JSON.stringify({ stopReason: run.stopReason, calls: provider.requests.length }))
`

it('preserves an exhausted review allowance across process exit and compacted feedback', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-review-restart-'))
	try {
		const script = join(root, 'worker.mjs')
		await writeFile(script, worker)
		const sdk = fileURLToPath(new URL('../../../../dist/index.js', import.meta.url))
		const run = async (mode: string) => {
			const { stdout } = await promisify(execFile)(process.execPath, [script, sdk, root, mode], {
				timeout: 20_000,
			})
			return JSON.parse(stdout.trim())
		}
		expect(await run('seed')).toEqual({ stopReason: 'answer_rejected', calls: 1 })
		expect(await run('resume')).toEqual({ stopReason: 'answer_rejected', calls: 0 })
	} finally {
		await removeTempDirAsync(root)
	}
}, 45_000)
