// Verifies, against the REAL interactive TUI (a genuine PTY subprocess, not a
// unit renderer), that the parent's narration band costs the agent rail
// nothing:
//
//   - render order below the message frame is frame -> footer -> narration ->
//     rail, on a terminal only 24 rows tall;
//   - every agent row the rail shows WITHOUT narration is still on screen WITH
//     it, borders included — the rows the band adds are paid for by the
//     conversation scrolling at the top, never by the rail at the bottom;
//   - a narration line is shown without stopping to ask the operator for
//     permission.
//
// It runs the same scripted session twice — once where the parent calls
// `narrate_work`, once where it does not — and compares the two rails. An A/B
// is the point: an assertion that the rail is "present" passes on a screen
// that has lost one of its rows, which is exactly the reading this file exists
// to prevent (see below).
//
// Technique (see the `cli-pty-dogfood-harness` note): a `pty`-forked driver
// (`tui-footer-order-drive.py`, reused unchanged) runs `node
// packages/cli/dist/bin.js` exactly as an operator's terminal would — typed
// keystrokes with real delays, not a burst that reads as a paste chip — and
// records the raw byte stream. A `--import` preload, written into the run's
// own temp root and not committed, replaces `ProviderRegistry.create` with a
// scripted provider: the parent narrates, spawns two background children
// sharing the workflow "Release audit", narrates again, then answers in plain
// text. Each child runs `bash sleep 25` so both are still live when the screen
// is captured. Checkpoints are raw byte offsets, replayed from byte 0 through
// a fresh headless VT emulator (`tui-footer-order-render.mjs`).
//
// READ THE VIEWPORT, NOT BUFFER ROW 0. This is the trap that made a correct
// layout look broken: once the frame outgrows the terminal the screen scrolls,
// and buffer row 0 is then the oldest line of SCROLLBACK, so `rows` lines read
// from there show the top of the session with the bottom of the screen
// missing — an agent row apparently "below the fold" that is in fact on
// screen. Both readings are reported here, side by side, so the difference is
// visible rather than a thing to be remembered.

import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { loadCapture, renderCheckpoint } from './tui-footer-order-render.mjs'

const exec = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const CLI_BIN = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url))
const CLI_PACKAGE_ROOT = fileURLToPath(new URL('../../packages/cli', import.meta.url))
const SDK_URL = new URL('../../packages/sdk/dist/index.js', import.meta.url).href
const OPENAI_PROVIDER_URL = new URL(
	'../../packages/providers/openai/dist/index.js',
	import.meta.url,
).href
const DRIVER = join(HERE, 'tui-footer-order-drive.py')
const RESULTS = join(HERE, 'narration-band-results.json')

const COLS = 100
// The classic minimum, and the size the layout question is actually about: a
// half-height split, a panel in an editor. At 30 rows there is slack enough
// that no arrangement of these rows can be wrong.
const ROWS = 24
const WORKFLOW_LABEL = 'Release audit'
const PROMPT_TEXT = 'Kick off the release audit workflow.'
const SUBAGENT_SYSTEM_MARKER = 'focused sub-agent dispatched by namzu'
const NARRATION_ONE = 'scan and verify are running in parallel; neither has reported yet'
const NARRATION_TWO = 'scan found two unsigned artifacts — verify will re-check them first'
const AGENT_ROWS = ['Scan release artifacts', 'Verify release artifacts']

function preloadSource(narrating) {
	const narrateFirst = narrating
		? `{ id: 'call-narrate-1', name: 'narrate_work', args: { line: ${JSON.stringify(NARRATION_ONE)} } },`
		: ''
	const narrateSecond = narrating
		? `{ toolCalls: [{ id: 'call-narrate-2', name: 'narrate_work', args: { line: ${JSON.stringify(NARRATION_TWO)} } }] }`
		: `{ text: 'Working on it.' }`
	return `import { ProviderRegistry, MockLLMProvider } from ${JSON.stringify(SDK_URL)}
import { CodexProvider } from ${JSON.stringify(OPENAI_PROVIDER_URL)}

const SUBAGENT_SYSTEM_MARKER = ${JSON.stringify(SUBAGENT_SYSTEM_MARKER)}
const WORKFLOW_LABEL = ${JSON.stringify(WORKFLOW_LABEL)}

function isChildRequest(params) {
	return params.messages.some(
		(m) => m.role === 'system' && String(m.content).includes(SUBAGENT_SYSTEM_MARKER),
	)
}

function scriptTurn(params, index) {
	if (isChildRequest(params)) {
		if (index === 0)
			return { toolCalls: [{ id: 'call-sleep', name: 'bash', args: { command: 'sleep 25' } }] }
		return { text: 'Done.' }
	}
	if (index === 0) {
		return {
			toolCalls: [
				${narrateFirst}
				{
					id: 'call-scan',
					name: 'Agent',
					args: {
						description: 'Scan release artifacts',
						prompt: 'run bash sleep 25, then report done.',
						subagent_type: 'general-purpose',
						workflow: WORKFLOW_LABEL,
						phase: 'Scan',
						phase_order: 0,
						run_in_background: true,
					},
				},
				{
					id: 'call-verify',
					name: 'Agent',
					args: {
						description: 'Verify release artifacts',
						prompt: 'run bash sleep 25, then report done.',
						subagent_type: 'general-purpose',
						workflow: WORKFLOW_LABEL,
						phase: 'Verify',
						phase_order: 1,
						run_in_background: true,
					},
				},
			],
		}
	}
	if (index === 1) return ${narrateSecond}
	if (index === 2)
		return {
			text: 'Both children are running in the background; I will report back once they finish.',
		}
	return { text: 'Understood.' }
}

ProviderRegistry.create = () => {
	const provider = new CodexProvider({ accessToken: 'fixture', accountId: 'fixture' })
	const mock = new MockLLMProvider({ nextTurn: scriptTurn })
	provider.chatStream = mock.chatStream.bind(mock)
	return { provider, capabilities: provider.capabilities }
}
`
}

/** Drive one scripted session and return its captured frames. */
async function driveOnce(narrating) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-narration-band-'))
	const home = join(root, 'home')
	const workspace = join(root, 'workspace')
	await mkdir(home)
	await mkdir(workspace)
	const canonicalWorkspace = realpathSync(workspace)
	await writeFile(
		join(home, 'trust.json'),
		`${JSON.stringify({ version: 1, trusted: [canonicalWorkspace] }, null, 2)}\n`,
	)
	await writeFile(
		join(home, 'preferences.json'),
		JSON.stringify({
			version: 3,
			providers: [{ id: 'codex', model: 'gpt-5.6-terra' }],
			subagents: { active: [] },
		}),
	)
	await writeFile(
		join(workspace, 'namzu.config.json'),
		JSON.stringify(
			{
				sandbox: { enabled: false },
				web: { search: 'off' },
				memory: { recall: false },
				permissions: { bash: 'allow', Agent: 'allow' },
			},
			null,
			2,
		),
	)

	const preloadPath = join(root, 'preload.mjs')
	await writeFile(preloadPath, preloadSource(narrating))
	const capturePath = join(root, 'capture.bin')
	const driverConfigPath = join(root, 'drive-config.json')
	await writeFile(
		driverConfigPath,
		JSON.stringify({
			argv: [process.execPath, '--import', preloadPath, CLI_BIN],
			cwd: workspace,
			env: { ...process.env, NAMZU_HOME: home },
			cols: COLS,
			rows: ROWS,
			capturePath,
			promptText: PROMPT_TEXT,
		}),
	)

	let driveResult
	let driveError
	try {
		await exec('python3', [DRIVER, driverConfigPath], { timeout: 180_000, maxBuffer: 10_000_000 })
	} catch (error) {
		driveError = error instanceof Error ? error.message : String(error)
	}
	try {
		driveResult = JSON.parse(await readFile(`${driverConfigPath}.result.json`, 'utf8'))
	} catch (error) {
		return { root, driveError: driveError ?? String(error), frames: {}, bufferTop: {} }
	}

	const bytes = await loadCapture(capturePath)
	const frames = {}
	const bufferTop = {}
	for (const [name, offset] of Object.entries(driveResult.checkpoints ?? {})) {
		const shared = { cliPackageRoot: CLI_PACKAGE_ROOT, bytes, upTo: offset, cols: COLS, rows: ROWS }
		frames[name] = await renderCheckpoint(shared)
		bufferTop[name] = await renderCheckpoint({ ...shared, fromBufferTop: true })
	}
	return { root, driveResult, ...(driveError ? { driveError } : {}), frames, bufferTop }
}

/** The rail's own rows on screen, top border through bottom border. */
function railBlock(rows) {
	const frame = rows.findIndex((row) => row.includes('└') && row.includes('┘'))
	if (frame < 0) return { error: 'message frame bottom border not on screen' }
	const top = rows.findIndex((row, index) => index > frame && row.trimStart().startsWith('┌'))
	if (top < 0) return { error: 'rail top border not on screen' }
	const bottom = rows.findIndex((row, index) => index > top && row.trimStart().startsWith('└'))
	if (bottom < 0) return { error: 'rail bottom border not on screen' }
	return { frame, top, block: rows.slice(top, bottom + 1) }
}

/**
 * Elapsed times tick between runs, and only they do. Comparing rails across
 * two sessions means comparing what the rail decided to show, not when it was
 * photographed.
 */
function withoutElapsed(block) {
	return block.map((row) => row.replace(/-?\d+(?:\.\d+)?[smh]/g, 'T'))
}

async function main() {
	const quiet = await driveOnce(false)
	const narrated = await driveOnce(true)
	const issues = []

	const quietRows = quiet.frames.two_live_agents
	const narratedRows = narrated.frames.two_live_agents
	if (!quietRows) issues.push('no-narration run captured no live-agents frame')
	if (!narratedRows) issues.push('narrated run captured no live-agents frame')

	let quietRail
	let narratedRail
	if (quietRows && narratedRows) {
		quietRail = railBlock(quietRows)
		narratedRail = railBlock(narratedRows)
		if (quietRail.error) issues.push(`no-narration run: ${quietRail.error}`)
		if (narratedRail.error) issues.push(`narrated run: ${narratedRail.error}`)
	}

	if (narratedRows && narratedRail && !narratedRail.error) {
		const footer = narratedRows[narratedRail.frame + 1] ?? ''
		if (!/shift\+tab to cycle|Auto-approve edits|Ask before changes/.test(footer))
			issues.push(`footer not directly under the message frame: ${JSON.stringify(footer)}`)
		const first = narratedRows[narratedRail.frame + 2] ?? ''
		const second = narratedRows[narratedRail.frame + 3] ?? ''
		if (!first.includes('scan and verify are running'))
			issues.push(`first narration row not under the footer: ${JSON.stringify(first)}`)
		if (!second.includes('scan found two unsigned artifacts'))
			issues.push(`second narration row not under the first: ${JSON.stringify(second)}`)
		if (narratedRail.top !== narratedRail.frame + 4)
			issues.push(`rail does not follow the narration: top row ${narratedRail.top}`)
		// The assertion the first pass was missing. A rail whose top border and
		// title are present can still have lost its last agent row off the
		// bottom of the screen; naming each row is what says it did not.
		for (const description of AGENT_ROWS) {
			if (!narratedRail.block.some((row) => row.includes(description)))
				issues.push(`narrated run lost the agent row "${description}"`)
		}
		if (!narratedRail.block.some((row) => row.includes(WORKFLOW_LABEL)))
			issues.push('narrated run lost the rail title')
		if (narratedRows.join('\n').includes('Allow narrate_work'))
			issues.push('narration stopped to ask the operator for permission')
	}

	if (quietRail?.block && narratedRail?.block) {
		const before = withoutElapsed(quietRail.block)
		const after = withoutElapsed(narratedRail.block)
		if (JSON.stringify(before) !== JSON.stringify(after))
			issues.push(
				`the rail differs with narration:\n${before.join('\n')}\n--- vs ---\n${after.join('\n')}`,
			)
	}

	for (const [label, run] of [
		['no narration', quiet],
		['narrated', narrated],
	]) {
		console.log(`\n===== ${label}: what is on screen (viewport) =====`)
		console.log((run.frames.two_live_agents ?? ['(missing)']).join('\n'))
		console.log(`\n===== ${label}: the same capture read from buffer row 0 =====`)
		console.log((run.bufferTop.two_live_agents ?? ['(missing)']).join('\n'))
	}
	console.log(`\nISSUES: ${issues.length === 0 ? 'none' : JSON.stringify(issues, null, 2)}`)

	await writeFile(
		RESULTS,
		`${JSON.stringify(
			{
				date: new Date().toISOString().slice(0, 10),
				scope:
					'Real interactive TUI under a PTY at 100x24, A/B with and without the parent calling narrate_work. ' +
					'Synthetic private workspace; scripted provider, no live model.',
				cols: COLS,
				rows: ROWS,
				issues,
				// The one checkpoint the A/B is about, in both readings. The rest of
				// the run's checkpoints are on disk under each root; archiving all
				// of them here would bury the two frames that carry the finding.
				quiet: {
					root: quiet.root,
					onScreen: quiet.frames.two_live_agents,
					fromBufferTop: quiet.bufferTop.two_live_agents,
				},
				narrated: {
					root: narrated.root,
					onScreen: narrated.frames.two_live_agents,
					fromBufferTop: narrated.bufferTop.two_live_agents,
				},
			},
			null,
			2,
		)}\n`,
	)
	if (issues.length > 0) process.exitCode = 1
}

await main()
