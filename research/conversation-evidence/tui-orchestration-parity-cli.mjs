// Drive the real namzu TUI under a PTY with a SCRIPTED provider through the
// two-phase, three-child colour scenario: turn orchestrate on in the effort
// picker, submit the prompt, approve each agent launch, let two background
// children name a colour, wait for both, run one join child, answer.
//
// usage: node tui-orchestration-parity-cli.mjs <repo-root> <label> <cols> <rows>
// Writes <label>.txt into the run's own temp root: every checkpoint rendered through a
// fresh headless VT emulator, then the whole buffer. The before/after frames
// in tui-orchestration-parity-results.md came from origin/main (92270560) and
// feat/orchestration-tui-parity built at the time.
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { loadCapture, renderCheckpoint } from './tui-footer-order-render.mjs'

const exec = promisify(execFile)
const [repo, label, colsArg, rowsArg] = process.argv.slice(2)
const cols = Number(colsArg ?? 120)
const rows = Number(rowsArg ?? 40)
const HERE = new URL('.', import.meta.url).pathname
// Run roots go under the OS temp directory, never into the repository.
const SCRATCH = tmpdir()
const CLI_BIN = join(repo, 'packages/cli/dist/bin.js')
const CLI_ROOT = join(repo, 'packages/cli')
const SDK_URL = `file://${join(repo, 'packages/sdk/dist/index.js')}`
const OPENAI_URL = `file://${join(repo, 'packages/providers/openai/dist/index.js')}`

const PROMPT =
	'Delegate this to subagents in two phases. Phase 1: two agents in parallel, each names one colour in a single word. Phase 2: one agent joins the two colours into one short sentence. Keep every agent tiny and report the sentence.'

const preload = `import { ProviderRegistry, MockLLMProvider } from ${JSON.stringify(SDK_URL)}
import { CodexProvider } from ${JSON.stringify(OPENAI_URL)}

const TASK = /as task ([0-9a-f-]{36})/g
const WORKFLOW = 'Two-phase colour sentence'
const text = (params) => JSON.stringify(params.messages)
const isParent = (s) => s.includes('Delegate this to subag')

function parentTurn(params) {
	const s = text(params)
	const assistants = params.messages.filter((m) => m.role === 'assistant').length
	const usage = { promptTokens: 3000, completionTokens: 120, totalTokens: 3120 }
	switch (assistants) {
		case 0:
			return { usage, text: 'Starting Phase 1 with two tiny agents in parallel.', toolCalls: [
				{ id: 'a1', name: 'Agent', args: { description: 'Choose first colour', prompt: 'FIRST: reply with one colour word.', subagent_type: 'explore', run_in_background: true, workflow: WORKFLOW, phase: 'Phase 1', phase_order: 0 } },
				{ id: 'a2', name: 'Agent', args: { description: 'Choose second colour', prompt: 'SECOND: reply with one colour word.', subagent_type: 'explore', run_in_background: true, workflow: WORKFLOW, phase: 'Phase 1', phase_order: 0 } },
			] }
		case 1: {
			const ids = [...new Set([...s.matchAll(TASK)].map((m) => m[1]))]
			return { usage, toolCalls: ids.map((id, i) => ({ id: 'w' + i, name: 'wait_for_task', args: { task_id: id } })) }
		}
		case 2:
			return { usage, text: 'Phase 1 returned Blue and Green; starting Phase 2.', toolCalls: [
				{ id: 'j1', name: 'Agent', args: { description: 'Join the two colours', prompt: 'JOIN: make one short sentence from Blue and Green.', subagent_type: 'explore', workflow: WORKFLOW, phase: 'Phase 2', phase_order: 1 } },
			] }
		default:
			return { usage, text: 'Blue and green sit side by side.' }
	}
}

function childTurn(params) {
	const s = text(params)
	const usage = { promptTokens: 8800, completionTokens: 200, totalTokens: 9000 }
	if (s.includes('JOIN:')) return { usage, text: 'Blue and green sit side by side.' }
	if (s.includes('FIRST:')) return { usage, text: 'Blue' }
	return { usage, text: 'Green' }
}

function delayFor(params) {
	const s = text(params)
	if (isParent(s)) return 700
	if (s.includes('JOIN:')) return 2000
	if (s.includes('FIRST:')) return 2600
	return 3800
}

ProviderRegistry.create = () => {
	const provider = new CodexProvider({ accessToken: 'fixture', accountId: 'fixture' })
	const mock = new MockLLMProvider({ nextTurn: (params) => (isParent(text(params)) ? parentTurn(params) : childTurn(params)) })
	provider.chatStream = async function* (params) {
		await new Promise((r) => setTimeout(r, delayFor(params)))
		yield* mock.chatStream(params)
	}
	provider.reasoningEffortLevelsFor = () => ['low', 'medium', 'high', 'xhigh', 'max']
	provider.reasoningEffortDefaultFor = () => undefined
	provider.listModels = async () => [{ id: 'gpt-5.6-luna', name: 'gpt-5.6-luna' }]
	return { provider, capabilities: provider.capabilities }
}
`

const STEPS = [
	{ op: 'type_submit', text: '/effort', expect: 'Reasoning', timeout: 20, label: 'effort' },
	{ op: 'checkpoint', name: 'effort_open', settle: 0.6 },
	{ op: 'key', name: 'right', settle: 0.4 },
	{ op: 'key', name: 'right', settle: 0.6 },
	{ op: 'checkpoint', name: 'effort_right_twice' },
	{ op: 'key', name: 'end', settle: 0.6 },
	{ op: 'checkpoint', name: 'effort_on_orchestrate' },
	{ op: 'key', name: 'enter', settle: 1.2 },
	{ op: 'checkpoint', name: 'orchestrate_on_idle' },
	// Phase 1 launches two agents in one response, so its review reads "Start 2 agents".
	{ op: 'type_submit', text: PROMPT, expect: 'Start 2 agents', timeout: 40, label: 'prompt' },
	{ op: 'checkpoint', name: 'review_phase1', settle: 0.6 },
	{ op: 'key', name: 'y', settle: 1.4 },
	{ op: 'checkpoint', name: 'phase1_running' },
	{ op: 'sleep', seconds: 1.2 },
	{ op: 'checkpoint', name: 'phase1_waiting' },
	{ op: 'wait_count', pattern: 'Start an agent', count: 1, timeout: 40, label: 'review2' },
	{ op: 'checkpoint', name: 'review_phase2', settle: 0.6 },
	{ op: 'key', name: 'y', settle: 1.0 },
	{ op: 'checkpoint', name: 'phase2_running' },
	{ op: 'wait_count', pattern: 'sit side by side', count: 2, timeout: 40, label: 'final' },
	{ op: 'sleep', seconds: 2.0 },
	{ op: 'checkpoint', name: 'turn_end' },
	{ op: 'key', name: 'ctrl_o', settle: 1.0 },
	{ op: 'checkpoint', name: 'ctrl_o_expanded' },
]

const root = await mkdtemp(join(SCRATCH, `${label}-`))
const home = join(root, 'home')
const workspace = join(root, 'workspace')
await mkdir(home)
await mkdir(workspace)
await writeFile(join(home, 'trust.json'), JSON.stringify({ version: 1, trusted: [realpathSync(workspace)] }))
await writeFile(
	join(home, 'preferences.json'),
	JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }),
)
await writeFile(
	join(workspace, 'namzu.config.json'),
	JSON.stringify({ sandbox: { enabled: false }, web: { search: 'off' }, memory: { recall: false } }),
)
const preloadPath = join(root, 'preload.mjs')
await writeFile(preloadPath, preload)
const capturePath = join(root, 'capture.bin')
const cfgPath = join(root, 'drive.json')
const env = { ...process.env, NAMZU_HOME: home }
delete env.CI
await writeFile(
	cfgPath,
	JSON.stringify({ argv: [process.execPath, '--import', preloadPath, CLI_BIN], cwd: workspace, env, cols, rows, capturePath, steps: STEPS }),
)
try {
	await exec('python3', [join(HERE, 'tui-orchestration-parity-drive.py'), cfgPath], { timeout: 400_000, maxBuffer: 10_000_000 })
} catch (error) {
	console.error('driver error', error.message)
}
const result = JSON.parse(await readFile(`${cfgPath}.result.json`, 'utf8'))
const bytes = await loadCapture(capturePath)
const out = [
	`# ${label} · ${cols}x${rows} · repo ${repo}`,
	`# run dir ${root}`,
	`# driver errors: ${JSON.stringify(result.errors)}`,
	`# markers: ${JSON.stringify(result.markersSeen)}`,
]
for (const [name, offset] of Object.entries(result.checkpoints)) {
	if (name === 'composer_ready' || name === 'settled') continue
	const frame = await renderCheckpoint({ cliPackageRoot: CLI_ROOT, bytes, upTo: offset, cols, rows })
	out.push('', `===== ${name} (byte ${offset}) =====`, ...frame)
}
{
	const { createRequire } = await import('node:module')
	const require = createRequire(`${CLI_ROOT}/package.json`)
	const { Terminal } = require('@xterm/headless')
	const t = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 })
	await new Promise((r) => t.write(bytes, r))
	const all = []
	for (let i = 0; i < t.buffer.active.length; i++) all.push((t.buffer.active.getLine(i)?.translateToString(false) ?? '').replace(/\s+$/u, ''))
	out.push('', '===== full buffer (scrollback + viewport) at the end =====', ...all)
	t.dispose()
}
await writeFile(join(root, `${label}.txt`), `${out.join('\n')}\n`)
console.log(`wrote ${join(root, `${label}.txt`)}`)
