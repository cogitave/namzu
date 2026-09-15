// Cross-process proof that the WS4 resume seed reconstructs file witnesses
// through the real CLI, with NO live model. Two `namzu run-stream --session
// <key>` invocations, each a *separate OS process*, share one NAMZU_HOME and
// one workspace. Process 1 writes notes.md and its turn is persisted;
// process 2 is a brand-new process whose in-memory FileReadTracker has never
// seen this session, so the ONLY way it can cite the write call id for
// notes.md is by reconstructing the ledger from the persisted conversation —
// exactly the mechanism `packages/cli/src/tui/agent.ts`'s `observationsFor`
// and `packages/sdk/src/runtime/query/file-evidence-seed.ts` add.
//
// Modeled on `continuation-cli.mjs` / `active-cli.mjs` / `reference-context-cli.mjs`.
// A single preload module supports two modes:
//   - `scripted` (default, and the only one this file executes): fully
//     replaces `ProviderRegistry.create` with a scripted provider built on
//     the SDK's `MockLLMProvider`, and logs every request's messages/tools
//     to a `requests-*.jsonl` file next to it.
//   - `live`: wraps the REAL `ProviderRegistry.create` (does not replace it)
//     and only observes — for a later, deliberate run against a real model.
//     Not invoked by this script; see `runLiveModeIsNotExecuted` below.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const rootURL = new URL('../../', import.meta.url)
const sdkURL = new URL('packages/sdk/dist/index.js', rootURL)
const cliBin = fileURLToPath(new URL('packages/cli/dist/bin.js', rootURL))
const sessionsURL = new URL('packages/cli/dist/integrations/sessions/store.js', rootURL)

const PROVIDER_ID = 'codex'
const MODEL_ID = 'gpt-5.6-terra'
const EFFORT = 'low'

// Files whose content the whole plumbing rests on. Hashed before and after
// every measurement so a mid-run rebuild (forbidden at this head anyway) is
// caught rather than silently producing a misleading pass/fail.
const DIST_FILES = [
	'packages/cli/dist/bin.js',
	'packages/cli/dist/tui/agent.js',
	'packages/cli/dist/commands/run-stream.js',
	'packages/cli/dist/integrations/sessions/store.js',
	'packages/sdk/dist/index.js',
	'packages/sdk/dist/provider/mock.js',
	'packages/sdk/dist/provider/registry.js',
	'packages/sdk/dist/runtime/query/executor.js',
	'packages/sdk/dist/runtime/query/file-evidence-seed.js',
	'packages/sdk/dist/runtime/query/file-evidence-context.js',
	'packages/sdk/dist/runtime/query/file-evidence-replay.js',
	'packages/sdk/dist/runtime/query/iteration/index.js',
	'packages/sdk/dist/tools/builtins/edit.js',
	'packages/sdk/dist/tools/builtins/write-file.js',
	'packages/sdk/dist/tools/builtins/content-fingerprint.js',
]

async function hashDist() {
	const out = {}
	for (const path of DIST_FILES) {
		try {
			out[path] = createHash('sha256').update(await readFile(new URL(path, rootURL))).digest('hex')
		} catch (error) {
			out[path] = `MISSING:${error.code ?? error.message}`
		}
	}
	return out
}

// --- Fixture bodies -------------------------------------------------------

const sentinel = `SENTINEL-${randomUUID()}`
function makeNotesBody(text) {
	const lines = []
	for (let i = 1; i <= 40; i++) {
		lines.push(
			i === 20
				? `Sentinel line: ${text} marks this exact revision.`
				: `Line ${i}: routine fixture content for the resume-witness harness.`,
		)
	}
	return `${lines.join('\n')}\n`
}
const originalBody = makeNotesBody(sentinel)
const sentinelLine = originalBody.split('\n')[19]
assert.ok(sentinelLine.includes(sentinel))
const driftedBody = originalBody.replace(
	'Line 1: routine fixture content for the resume-witness harness.',
	'Line 1: EXTERNALLY MODIFIED after process 1 exited — not the agent.',
)
assert.notEqual(driftedBody, originalBody)

// --- Preload (both modes) --------------------------------------------------

/**
 * `mode: 'scripted'` fully replaces ProviderRegistry.create with a
 * MockLLMProvider-backed stub and logs each request. `mode: 'live'` wraps
 * the real create() and only observes — written for completeness, never
 * invoked by this file (see runLiveModeIsNotExecuted).
 */
function preloadSource({ mode, turns, requestLogPath }) {
	if (mode === 'live') {
		return `import { ProviderRegistry } from ${JSON.stringify(sdkURL.href)}
import { appendFile } from 'node:fs/promises'
const original = ProviderRegistry.create.bind(ProviderRegistry)
let requestIndex = 0
ProviderRegistry.create = (...args) => {
  const created = original(...args)
  const stream = created.provider.chatStream.bind(created.provider)
  created.provider.chatStream = async function* (params) {
    const stepContext = params.messages.filter((m) => m.source?.type === 'runtime-context' && m.source.kind === 'step-context')
    const record = {
      requestIndex: requestIndex++,
      messageCount: params.messages.length,
      roles: params.messages.map((m) => m.role),
      toolNames: (params.tools ?? []).map((t) => t.function?.name ?? t.name ?? null),
      stepContextContents: stepContext.map((m) => m.content),
    }
    await appendFile(${JSON.stringify(requestLogPath)}, JSON.stringify(record) + '\\n')
    yield* stream(params)
  }
  return created
}
`
	}
	return `import { ProviderRegistry, MockLLMProvider } from ${JSON.stringify(sdkURL.href)}
import { appendFile } from 'node:fs/promises'
const turns = ${JSON.stringify(turns)}
const mock = new MockLLMProvider({ turns })
let requestIndex = 0
ProviderRegistry.create = () => ({
  provider: {
    id: mock.id,
    name: mock.name,
    capabilities: mock.capabilities,
    async *chatStream(params) {
      const stepContext = params.messages.filter((m) => m.source?.type === 'runtime-context' && m.source.kind === 'step-context')
      const priorReadCallsForNotes = params.messages
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => m.toolCalls ?? [])
        .filter((c) => c.function.name === 'read' && c.function.arguments.includes('notes.md'))
        .map((c) => c.id)
      const readCallIds = new Set(priorReadCallsForNotes)
      const priorReadResultCount = params.messages.filter(
        (m) => m.role === 'tool' && readCallIds.has(m.toolCallId),
      ).length
      const record = {
        requestIndex: requestIndex++,
        messageCount: params.messages.length,
        roles: params.messages.map((m) => m.role),
        toolNames: (params.tools ?? []).map((t) => t.function?.name ?? t.name ?? null),
        stepContextKinds: params.messages.filter((m) => m.source?.type === 'runtime-context').map((m) => m.source.kind),
        stepContextContents: stepContext.map((m) => m.content),
        priorReadCallsForNotes,
        priorReadResultCount,
      }
      await appendFile(${JSON.stringify(requestLogPath)}, JSON.stringify(record) + '\\n')
      yield* mock.chatStream(params)
    },
    async listModels() {
      return mock.listModels()
    },
    async healthCheck() {
      return mock.healthCheck()
    },
  },
})
`
}

// --- CLI process runner -----------------------------------------------------

async function runCli({ home, cwd, args, preload }) {
	const startedAt = Date.now()
	let stdout = ''
	let stderr = ''
	let code = 0
	try {
		const result = await exec(process.execPath, ['--import', preload, cliBin, ...args], {
			cwd,
			env: { ...process.env, NAMZU_HOME: home, NAMZU_LOG_LEVEL: 'debug' },
			timeout: 90_000,
			maxBuffer: 8_000_000,
		})
		stdout = result.stdout
		stderr = result.stderr
	} catch (error) {
		stdout = error.stdout ?? ''
		stderr = error.stderr ?? ''
		code = typeof error.code === 'number' ? error.code : 1
	}
	const durationMs = Date.now() - startedAt
	const events = stdout
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line)
			} catch {
				return { kind: 'unparsed', line }
			}
		})
	const logLines = stderr
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line)
			} catch {
				return null
			}
		})
		.filter(Boolean)
	return { code, args, events, logLines, durationMs }
}

async function listRunDirs(home, sessionId) {
	const runsDir = join(home, 'sessions', sessionId, 'runs')
	try {
		return (await readdir(runsDir, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
	} catch (error) {
		if (error.code === 'ENOENT') return []
		throw error
	}
}

async function readTranscript(home, sessionId, runId) {
	const path = join(home, 'sessions', sessionId, 'runs', runId, 'transcript.jsonl')
	const text = await readFile(path, 'utf8')
	return text
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line))
}

async function readJsonlIfPresent(path) {
	try {
		const text = await readFile(path, 'utf8')
		return text
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line))
	} catch (error) {
		if (error.code === 'ENOENT') return []
		throw error
	}
}

function summarizeMessages(messages) {
	return messages.map((m) => ({
		role: m.role,
		source: m.source ?? null,
		toolCalls: (m.toolCalls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
		toolCallId: m.toolCallId,
		isError: m.isError,
		content: typeof m.content === 'string' ? m.content : m.content === null ? null : '[blocks]',
	}))
}

// --- One flow: two processes sharing NAMZU_HOME + workspace + session key --

async function runFlow({ label, root, editAttempt }) {
	const home = join(root, label, 'home')
	const cwd = join(root, label, 'workspace')
	await mkdir(home, { recursive: true })
	await mkdir(cwd, { recursive: true })
	await writeFile(
		join(home, 'preferences.json'),
		JSON.stringify({ version: 3, providers: [{ id: PROVIDER_ID, model: MODEL_ID }], subagents: { active: [] } }),
	)
	// `compaction.recallEvidence`/`resolveEvidenceQueries` add an EXTRA
	// planner provider request ("Resolve a conversation-history search
	// query...") ahead of the real turn, which would otherwise steal the
	// first entry off our scripted MockLLMProvider turn queue. Disabled so
	// request index 0 in requests-p2.jsonl is the actual turn request.
	await writeFile(
		join(home, 'config.yaml'),
		'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\ncompaction:\n  recallEvidence: false\n  resolveEvidenceQueries: false\n',
	)

	const sessionKey = `resume-witness-${label}`
	const commonArgs = (prompt, maxIterations, tokenBudget) => [
		'run-stream',
		'--session',
		sessionKey,
		'--trust',
		'--cwd',
		cwd,
		'--provider',
		PROVIDER_ID,
		'--model',
		MODEL_ID,
		'--effort',
		EFFORT,
		'--max-iterations',
		String(maxIterations),
		'--token-budget',
		String(tokenBudget),
		prompt,
	]

	const flow = { label, home, cwd, sessionKey, editAttempt: Boolean(editAttempt) }

	// --- Process 1: create notes.md, turn 1 writes, turn 2 answers in text ---
	const requestLogP1 = join(root, label, 'requests-p1.jsonl')
	const preloadP1 = join(root, label, 'preload-p1.mjs')
	await writeFile(
		preloadP1,
		preloadSource({
			mode: 'scripted',
			requestLogPath: requestLogP1,
			turns: [
				{ toolCalls: [{ id: 'w1', name: 'write', args: { path: 'notes.md', content: originalBody } }] },
				{ text: 'Created notes.md with the fixture content.' },
			],
		}),
	)
	flow.process1 = await runCli({
		home,
		cwd,
		preload: preloadP1,
		args: commonArgs('create notes.md', 4, 20_000),
	})
	flow.process1.requests = await readJsonlIfPresent(requestLogP1)
	flow.process1.done = flow.process1.events.findLast((e) => e.kind === 'done')
	flow.process1.errors = flow.process1.events.filter((e) => e.kind === 'error')
	flow.process1.diskAfter = await readFile(join(cwd, 'notes.md'), 'utf8').catch((e) => `ERROR:${e.code}`)

	// --- Snapshot the persisted store between processes (no CLI process involved) ---
	const { openSessions, findMappedConversation, loadConversation } = await import(sessionsURL)
	const sessions = await openSessions(cwd, { stateRoot: home })
	const conversationId = await findMappedConversation(sessions, sessionKey)
	flow.conversationId = conversationId
	flow.persistedAfterProcess1 = conversationId
		? summarizeMessages(await loadConversation(sessions, conversationId))
		: null
	const runDirsAfterP1 = conversationId ? await listRunDirs(home, conversationId) : []

	// --- Optional disk drift, between process 1 and process 2 ---
	if (editAttempt) {
		await writeFile(join(cwd, 'notes.md'), driftedBody)
		flow.driftedBody = driftedBody
	}
	flow.diskBeforeProcess2 = await readFile(join(cwd, 'notes.md'), 'utf8')

	// --- Process 2: brand-new process, same session key, no write in its own history ---
	const requestLogP2 = join(root, label, 'requests-p2.jsonl')
	const preloadP2 = join(root, label, 'preload-p2.mjs')
	const turnsP2 = editAttempt
		? [
				{
					toolCalls: [
						{
							id: 'e1',
							name: 'edit',
							args: { path: 'notes.md', old_string: sentinelLine, new_string: 'Sentinel line: REPLACED — this edit must never apply.' },
						},
					],
				},
				{ text: 'notes.md changed on disk since it was last observed, so the edit was not applied.' },
			]
		: [{ text: 'notes.md contains the fixture notes created in the previous process.' }]
	await writeFile(preloadP2, preloadSource({ mode: 'scripted', requestLogPath: requestLogP2, turns: turnsP2 }))
	flow.process2 = await runCli({
		home,
		cwd,
		preload: preloadP2,
		args: commonArgs(editAttempt ? "fix notes.md's sentinel line" : 'what does notes.md say?', 4, 20_000),
	})
	flow.process2.requests = await readJsonlIfPresent(requestLogP2)
	flow.process2.done = flow.process2.events.findLast((e) => e.kind === 'done')
	flow.process2.errors = flow.process2.events.filter((e) => e.kind === 'error')
	flow.process2.diskAfter = await readFile(join(cwd, 'notes.md'), 'utf8')
	flow.process2.ledgerRebuiltLog = flow.process2.logLines.find((l) => l.body === 'file observation ledger rebuilt')
	flow.process2.ledgerNotRebuiltLog = flow.process2.logLines.find((l) => l.body === 'file observation ledger not rebuilt')

	const runDirsAfterP2 = conversationId ? await listRunDirs(home, conversationId) : []
	const newRunIds = runDirsAfterP2.filter((id) => !runDirsAfterP1.includes(id))
	flow.process2.newRunIds = newRunIds
	flow.process2.transcript = newRunIds.length === 1 ? await readTranscript(home, conversationId, newRunIds[0]) : []
	flow.process2.toolCompletions = flow.process2.transcript
		.filter((e) => e.type === 'tool_completed')
		.map((e) => ({ toolUseId: e.toolUseId, toolName: e.toolName, isError: e.isError, result: e.result }))

	return flow
}

// --- Assertions per flow -----------------------------------------------------

function stepContextEvidenceEntries(request) {
	return (request?.stepContextContents ?? []).filter((c) => typeof c === 'string' && c.includes('Visible file evidence'))
}

function checkNormalFlow(flow) {
	const checks = []
	const record = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail })

	record('process1 finished end_turn', flow.process1.done?.stopReason === 'end_turn', flow.process1.done?.stopReason)
	record('process1 no errors', flow.process1.errors.length === 0, flow.process1.errors)
	record('notes.md written with sentinel body', flow.process1.diskAfter === originalBody, {
		matches: flow.process1.diskAfter === originalBody,
	})
	record('turn persisted (conversationId resolved)', Boolean(flow.conversationId), flow.conversationId)
	record(
		'persisted history contains write call w1 for notes.md',
		flow.persistedAfterProcess1?.some((m) => m.toolCalls.some((c) => c.id === 'w1' && c.name === 'write' && c.arguments.includes('notes.md'))),
		flow.persistedAfterProcess1?.flatMap((m) => m.toolCalls),
	)

	const first = flow.process2.requests[0]
	record('process2 made at least one provider request', Boolean(first), flow.process2.requests.length)
	const evidenceEntries = stepContextEvidenceEntries(first)
	record('process2 first request: exactly one Visible-file-evidence step-context message', evidenceEntries.length === 1, {
		count: evidenceEntries.length,
	})
	record(
		"process2 first request: evidence names notes.md and write call id 'w1'",
		evidenceEntries.length === 1 && evidenceEntries[0].includes('notes.md') && evidenceEntries[0].includes('"bodyInCall":"w1"'),
		evidenceEntries[0],
	)
	record(
		'process2 first request: seed fired (ledger rebuilt log line present)',
		Boolean(flow.process2.ledgerRebuiltLog),
		flow.process2.ledgerRebuiltLog,
	)
	record(
		'process2 first request: ledger witnessed at least one path',
		(flow.process2.ledgerRebuiltLog?.attributes?.['namzu.files.witnessed'] ?? 0) >= 1,
		flow.process2.ledgerRebuiltLog?.attributes,
	)
	record(
		'process2 first request: no prior read tool call for notes.md',
		(first?.priorReadCallsForNotes ?? []).length === 0,
		first?.priorReadCallsForNotes,
	)
	record(
		'process2 first request: no prior read tool RESULT for notes.md',
		(first?.priorReadResultCount ?? 0) === 0,
		first?.priorReadResultCount,
	)
	record('process2 finished end_turn', flow.process2.done?.stopReason === 'end_turn', flow.process2.done?.stopReason)
	record('workspace file unchanged by process2', flow.process2.diskAfter === originalBody, {
		matches: flow.process2.diskAfter === originalBody,
	})

	return checks
}

function checkDriftFlow(flow) {
	const checks = []
	const record = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail })

	record('process1 finished end_turn', flow.process1.done?.stopReason === 'end_turn', flow.process1.done?.stopReason)
	record('notes.md written with sentinel body', flow.process1.diskAfter === originalBody, null)
	record('disk drifted between processes (content differs from what process1 wrote)', flow.diskBeforeProcess2 === driftedBody, null)

	const [first, second] = flow.process2.requests
	const firstEvidence = stepContextEvidenceEntries(first)
	record(
		'process2 first request STILL shows Visible file evidence (seed predates the drift observation)',
		firstEvidence.length === 1 && firstEvidence[0].includes('"bodyInCall":"w1"'),
		firstEvidence[0],
	)
	record(
		'process2 first request: seed fired (ledger rebuilt log line present)',
		Boolean(flow.process2.ledgerRebuiltLog),
		flow.process2.ledgerRebuiltLog,
	)

	const editCompletion = flow.process2.toolCompletions.find((c) => c.toolUseId === 'e1')
	record('edit call e1 executed and was refused', editCompletion?.isError === true, editCompletion)
	record("refusal names the drift ('changed on disk')", Boolean(editCompletion?.result?.includes('changed on disk')), editCompletion?.result)

	const secondEvidence = stepContextEvidenceEntries(second)
	record(
		'process2 SECOND request carries NO Visible-file-evidence entry (drift withdrew it)',
		Boolean(second) && secondEvidence.length === 0,
		{ hadSecondRequest: Boolean(second), secondEvidence },
	)

	record('on-disk drift survived untouched after process2', flow.process2.diskAfter === driftedBody, {
		matches: flow.process2.diskAfter === driftedBody,
	})

	return checks
}

// --- Control: is there a supported switch to disable the seed? -------------

function controlNote() {
	return {
		attempted: false,
		reason:
			"grepped packages/sdk/src and packages/cli/src for a disable switch (env var or config key) covering seedFileObservations / observationsFor / the file-evidence-context projection — none exists. No config key, no NAMZU_* env var. Per task instructions this control is skipped rather than adding product code to support it.",
	}
}

/** Documented, never invoked: the live variant needs a real, non-rate-limited model. */
function runLiveModeIsNotExecuted() {
	return {
		executed: false,
		wouldUse: { provider: PROVIDER_ID, model: MODEL_ID, effort: EFFORT },
		reason: 'Terra/Codex is rate-limited today; this task needs no live judgment, only kernel plumbing.',
	}
}

// --- Main --------------------------------------------------------------------

async function main() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-resume-witness-'))
	const report = {
		root,
		sentinel,
		originalBody,
		driftedBody,
		provider: PROVIDER_ID,
		model: MODEL_ID,
		effort: EFFORT,
		control: controlNote(),
		liveMode: runLiveModeIsNotExecuted(),
	}
	try {
		report.buildBefore = await hashDist()

		const normal = await runFlow({ label: 'normal', root, editAttempt: false })
		normal.checks = checkNormalFlow(normal)
		normal.passed = normal.checks.every((c) => c.pass)

		const drift = await runFlow({ label: 'drift', root, editAttempt: true })
		drift.checks = checkDriftFlow(drift)
		drift.passed = drift.checks.every((c) => c.pass)

		report.flows = { normal, drift }
		report.buildAfter = await hashDist()
		report.buildStable = JSON.stringify(report.buildBefore) === JSON.stringify(report.buildAfter)
		report.passed = report.buildStable && normal.passed && drift.passed
		if (!report.buildStable) report.error = 'Build changed during measurement — dist was rebuilt mid-run.'
	} catch (error) {
		report.passed = false
		report.error = String(error?.stack ?? error)
	} finally {
		await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2))
		console.log(
			JSON.stringify(
				{
					root,
					passed: report.passed,
					buildStable: report.buildStable,
					normalChecks: report.flows?.normal.checks,
					driftChecks: report.flows?.drift.checks,
					error: report.error,
				},
				null,
				2,
			),
		)
		if (!report.passed) process.exitCode = 1
	}
	return report
}

const result = await main()
export { result }
