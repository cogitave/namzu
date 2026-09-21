import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'

// Two separate consumers of the built package and a session on disk. The
// first process dies right after its turn checkpointed a rejected answer;
// no in-memory counter or message scan can carry the exhausted allowance
// into the second, which resumes the same turn from the log.
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
const paths = new sdk.SessionPaths({ home: join(root, 'home'), slug: 'review-restart' })
const log = sdk.DiskSessionLog.at(paths, { sessionId: state.sessionId })
// A short lease, so the second process can take the session the first left.
const lease = await log.claim({ holder: 'review-restart:' + mode + ':' + process.pid, ttlMs: 500 })
if (!lease) throw new Error('the session is held')
const provider = new sdk.MockLLMProvider({ turns: [{ text: 'Unverified.' }] })
const params = {
  ...state, paths, lease, provider, tools: new sdk.ToolRegistry(),
  agentId: 'review-restart', agentName: 'Review restart', workingDirectory: root,
  turnConfig: { model: 'mock', tokenBudget: 10000, maxIterations: 5, timeoutMs: 10000 },
  maxAnswerReviews: 0, reviewAnswer: () => ({ accept: false, feedback: 'Evidence mismatch.' }),
}
if (mode === 'seed') {
  // The process dies the moment the checkpoint of the rejected answer is
  // committed to the log: no settle, no lease release.
  let target
  class CommittingStore extends sdk.DiskSessionCheckpointStore {
    async write(scope, checkpoint) {
      const receipt = await super.write(scope, checkpoint)
      if (checkpoint.review.answerAttempts === 1) target = checkpoint.checkpointId
      return receipt
    }
  }
  class DyingLog extends sdk.DiskSessionLog {
    async append(lease, draft) {
      const entry = await super.append(lease, draft)
      if (draft.type === 'checkpoint_written' && draft.checkpointId === target) {
        await writeFile(stateFile, JSON.stringify({ ...state, checkpointId: target }))
        console.log(JSON.stringify({ checkpointed: true, calls: provider.requests.length }))
        process.exit(0)
      }
      return entry
    }
  }
  const locator = { sessionId: state.sessionId }
  const sessionLog = new DyingLog({
    sessionId: state.sessionId, file: paths.sessionLog(locator), sessionDir: paths.sessionDir(locator),
  })
  // Writing only: nothing is verified against the log in this process.
  const checkpointStore = new CommittingStore({ paths, log: {
    verifyThrough: async () => true, writtenDocSha256: async () => null, openDecisionCheckpoints: async () => [],
  } })
  await sdk.drainQuery({
    ...params, sessionLog, checkpointStore, messages: [sdk.createUserMessage('Give a verified answer.')],
  })
  console.log(JSON.stringify({ checkpointed: false, calls: provider.requests.length }))
} else {
  const turn = await sdk.drainQuery({ ...params, messages: [], resumeFromCheckpoint: state.checkpointId })
  console.log(JSON.stringify({ stopReason: turn.stopReason, turnId: turn.id === state.turnId, calls: provider.requests.length }))
}
`

it('preserves an exhausted review allowance across process exit', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-review-restart-'))
	try {
		const script = join(root, 'worker.mjs')
		await writeFile(script, worker)
		const sdk = fileURLToPath(new URL('../../../../dist/index.js', import.meta.url))
		const run = async (mode: string) => {
			const { stdout } = await promisify(execFile)(process.execPath, [script, sdk, root, mode], {
				timeout: 20_000,
			})
			return JSON.parse(stdout.trim().split('\n').at(-1) ?? '')
		}
		expect(await run('seed')).toEqual({ checkpointed: true, calls: 1 })
		// Past the dead process's lease.
		await new Promise((resolve) => setTimeout(resolve, 700))
		expect(await run('resume')).toEqual({ stopReason: 'answer_rejected', turnId: true, calls: 0 })
	} finally {
		await removeTempDirAsync(root)
	}
}, 45_000)
