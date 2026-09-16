// Verifies, against the REAL interactive TUI (a genuine PTY subprocess, not
// a unit renderer), the footer-order-and-rail-title fix in
// `03f5483a fix(cli): put the mode line under the message box and title the
// agents rail by its workflow`:
//
//   - render order below the message frame is frame -> footer -> agent rail
//     (the footer's own row is fixed relative to the frame's bottom border,
//     never to whichever full-screen surface follows it);
//   - the rail's title, and the agent cockpit's per-workflow header, read the
//     shared workflow label ("Release audit" here) rather than the generic
//     "Delegated work" placeholder.
//
// Technique (see the `cli-pty-dogfood-harness` note): a Python `pty`-forked
// subprocess (`tui-footer-order-drive.py`) drives `node
// packages/cli/dist/bin.js` exactly as an operator's terminal would — typed
// keystrokes with real delays, not a burst that reads as a paste chip — and
// records the raw byte stream. A `--import` preload
// (`tui-footer-order-preload.mjs`, written into the run's own temp root, not
// committed — its content is inlined below and archived in
// `tui-footer-order-results.json`) replaces `ProviderRegistry.create` with a
// scripted provider: the first user turn gets an `Agent` tool call spawning
// two children sharing workflow "Release audit" (phases "Scan"/"Verify"),
// each of which runs `bash sleep 20` so it is still "running" when the
// screen is captured, then the parent answers with plain text. Three
// checkpoints are captured as raw byte offsets into that recording and each
// is independently replayed, from byte 0, through a fresh headless VT
// emulator (`tui-footer-order-render.mjs`, the same `@xterm/headless` the
// package's own `screen.ts` test support uses) — ANSI cursor state is
// sequential, so a trustworthy read of "what the screen showed at offset N"
// requires exactly that, never a live emulator sampled mid-stream.
//
// Modeled on `active-cli.mjs` (preload structure) and `text-phases-cli.mjs`
// (constructing a real driver with fixture credentials rather than fighting
// its synchronous "access token required" guard).

import assert from 'node:assert/strict'
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
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const CLI_BIN = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url))
const CLI_PACKAGE_ROOT = fileURLToPath(new URL('../../packages/cli', import.meta.url))
const SDK_URL = new URL('../../packages/sdk/dist/index.js', import.meta.url).href
const OPENAI_PROVIDER_URL = new URL('../../packages/providers/openai/dist/index.js', import.meta.url).href
const DRIVER = join(HERE, 'tui-footer-order-drive.py')

const COLS = 100
const ROWS = 30
const WORKFLOW_LABEL = 'Release audit'
const CHILD_SCAN_MARKER = 'CHILD-SCAN-MARKER'
const CHILD_VERIFY_MARKER = 'CHILD-VERIFY-MARKER'
const SUBAGENT_SYSTEM_MARKER = 'focused sub-agent dispatched by namzu'
const PROMPT_TEXT = 'Kick off the release audit workflow.'

// Files whose content this experiment rests on. Hashed before and after so a
// mid-run rebuild (forbidden at this head anyway — dist is frozen by the fix
// step) would be caught rather than silently producing a misleading result.
const DIST_FILES = [
	'packages/cli/dist/bin.js',
	'packages/cli/dist/tui/App.js',
	'packages/cli/dist/tui/AgentExplorer.js',
	'packages/cli/dist/tui/StatusBar.js',
	'packages/cli/dist/integrations/subagents/runtime.js',
	'packages/cli/dist/integrations/subagents/activity.js',
]

async function hashDist() {
	const { createHash } = await import('node:crypto')
	const out = {}
	for (const path of DIST_FILES) {
		try {
			out[path] = createHash('sha256').update(await readFile(new URL(path, REPO_ROOT))).digest('hex')
		} catch (error) {
			out[path] = `MISSING:${error.code ?? error.message}`
		}
	}
	return out
}

function preloadSource() {
	return `import { ProviderRegistry, MockLLMProvider } from ${JSON.stringify(SDK_URL)}
import { CodexProvider } from ${JSON.stringify(OPENAI_PROVIDER_URL)}
import { appendFile } from 'node:fs/promises'

const LOG = ${JSON.stringify(join('__ROOT__', 'requests.jsonl'))}
const WORKFLOW_LABEL = ${JSON.stringify(WORKFLOW_LABEL)}
const CHILD_SCAN_MARKER = ${JSON.stringify(CHILD_SCAN_MARKER)}
const CHILD_VERIFY_MARKER = ${JSON.stringify(CHILD_VERIFY_MARKER)}
const SUBAGENT_SYSTEM_MARKER = ${JSON.stringify(SUBAGENT_SYSTEM_MARKER)}

function isChildRequest(params) {
	return params.messages.some(
		(m) => m.role === 'system' && String(m.content).includes(SUBAGENT_SYSTEM_MARKER),
	)
}

function scriptTurn(params, index) {
	const child = isChildRequest(params)
	void appendFile(
		LOG,
		JSON.stringify({
			index,
			child,
			roles: params.messages.map((m) => m.role),
		}) + '\\n',
	).catch(() => {})
	if (child) {
		if (index === 0) {
			return { toolCalls: [{ id: 'call-sleep', name: 'bash', args: { command: 'sleep 20' } }] }
		}
		return { text: 'Done.' }
	}
	if (index === 0) {
		return {
			toolCalls: [
				{
					id: 'call-scan',
					name: 'Agent',
					args: {
						description: 'Scan release artifacts',
						prompt: CHILD_SCAN_MARKER + ': run \`bash\` with \`sleep 20\` to simulate a scan step, then report done.',
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
						prompt: CHILD_VERIFY_MARKER + ': run \`bash\` with \`sleep 20\` to simulate a verify step, then report done.',
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
	if (index === 1) {
		return {
			text: 'Started the ' + WORKFLOW_LABEL + ' workflow. Scan and Verify are both running in the background; I will report back once they finish.',
		}
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

async function main() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-tui-footer-order-'))
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

	const preloadPath = join(root, 'tui-footer-order-preload.mjs')
	const preloadBody = preloadSource().replaceAll('__ROOT__', root)
	await writeFile(preloadPath, preloadBody)

	const capturePath = join(root, 'capture.bin')
	const driverConfigPath = join(root, 'drive-config.json')
	const driverConfig = {
		argv: [process.execPath, '--import', preloadPath, CLI_BIN],
		cwd: workspace,
		env: { ...process.env, NAMZU_HOME: home },
		cols: COLS,
		rows: ROWS,
		capturePath,
		promptText: PROMPT_TEXT,
	}
	await writeFile(driverConfigPath, JSON.stringify(driverConfig))

	const buildBefore = await hashDist()

	const report = {
		date: new Date().toISOString().slice(0, 10),
		scope:
			'Real interactive TUI under a PTY (not a unit renderer): footer-order-and-rail-title fix, ' +
			'03f5483a. Synthetic private workspace; scripted provider, no live model.',
		root,
		cols: COLS,
		rows: ROWS,
		workflowLabel: WORKFLOW_LABEL,
		promptText: PROMPT_TEXT,
	}

	let driveResult
	try {
		await exec('python3', [DRIVER, driverConfigPath], {
			timeout: 150_000,
			maxBuffer: 10_000_000,
		})
	} catch (error) {
		report.driveError = {
			message: error instanceof Error ? error.message : String(error),
			stdout: error?.stdout,
			stderr: error?.stderr,
		}
	}
	try {
		driveResult = JSON.parse(await readFile(`${driverConfigPath}.result.json`, 'utf8'))
	} catch (error) {
		report.driveResultReadError = error instanceof Error ? error.message : String(error)
	}
	report.driveResult = driveResult

	const buildAfter = await hashDist()
	report.buildStable = JSON.stringify(buildBefore) === JSON.stringify(buildAfter)
	if (!report.buildStable) {
		report.buildBefore = buildBefore
		report.buildAfter = buildAfter
	}

	report.requestLog = await readFile(join(root, 'requests.jsonl'), 'utf8')
		.then((text) =>
			text
				.trim()
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		)
		.catch(() => [])

	const issues = []
	const frames = {}

	if (!driveResult) {
		issues.push('The PTY driver produced no result file; see driveError/driveResult above.')
	} else {
		const bytes = await loadCapture(capturePath)
		report.totalCapturedBytes = bytes.length
		const checkpoints = driveResult.checkpoints ?? {}

		for (const [name, offset] of Object.entries(checkpoints)) {
			frames[name] = await renderCheckpoint({
				cliPackageRoot: CLI_PACKAGE_ROOT,
				bytes,
				upTo: offset,
				cols: COLS,
				rows: ROWS,
			})
		}

		for (const error of driveResult.errors ?? []) issues.push(`driver: ${error}`)

		// --- Assertion 1: footer sits directly under the message frame's
		// bottom border, whether or not a rail follows it. ---
		function frameBorderIndex(rows) {
			return rows.findIndex((line) => line.includes('└') && line.includes('┘'))
		}

		const idleRows = frames.idle_mode_on
		if (idleRows) {
			const border = frameBorderIndex(idleRows)
			if (border < 0) {
				issues.push('idle_mode_on: message frame bottom border not found on screen.')
			} else {
				const footer = idleRows[border + 1] ?? ''
				report.footerRowIdle = footer
				if (!/shift\+tab to cycle/.test(footer)) {
					issues.push(`idle_mode_on: footer row does not carry the mode hint: ${JSON.stringify(footer)}`)
				}
				if (!/Auto-approve edits|Ask before changes/.test(footer)) {
					issues.push(`idle_mode_on: footer row does not show a mode badge: ${JSON.stringify(footer)}`)
				}
			}
		} else {
			issues.push('idle_mode_on checkpoint missing.')
		}

		const agentsRows = frames.two_live_agents
		if (agentsRows) {
			const border = frameBorderIndex(agentsRows)
			let railRows = agentsRows
			if (border < 0) {
				issues.push('two_live_agents: message frame bottom border not found on screen.')
			} else {
				const footer = agentsRows[border + 1] ?? ''
				report.footerRowWithAgents = footer
				if (!/shift\+tab to cycle|Auto-approve edits|Ask before changes/.test(footer)) {
					issues.push(`two_live_agents: footer row missing at expected position: ${JSON.stringify(footer)}`)
				}
				const railTop = agentsRows[border + 2] ?? ''
				report.railTopRow = railTop
				if (!railTop.trimStart().startsWith('┌')) {
					issues.push(
						`two_live_agents: expected the rail's own top border directly under the footer, got: ${JSON.stringify(railTop)}`,
					)
				}
				// The rail itself, not the transcript above it (which may also
				// happen to mention the workflow label in the assistant's own
				// text — that is not the title this checks).
				railRows = agentsRows.slice(border + 2)
			}
			const joined = railRows.join('\n')
			report.railTitleLine = railRows.find((line) => line.includes(WORKFLOW_LABEL)) ?? null
			if (!joined.includes(WORKFLOW_LABEL)) {
				issues.push(`two_live_agents: rail does not show the shared workflow label "${WORKFLOW_LABEL}".`)
			}
			if (joined.includes('Delegated work')) {
				issues.push('two_live_agents: rail still shows the literal "Delegated work" title.')
			}
			if (!/·\s*↓\s*\/\s*ctrl\+t/.test(joined)) {
				issues.push('two_live_agents: rail is missing the right-hand "· ↓ / ctrl+t" hint.')
			}
		} else {
			issues.push('two_live_agents checkpoint missing.')
		}

		const cockpitRows = frames.cockpit
		if (cockpitRows) {
			const joined = cockpitRows.join('\n')
			report.cockpitTitleLine = cockpitRows.find((line) => line.includes(WORKFLOW_LABEL)) ?? null
			if (!joined.includes(WORKFLOW_LABEL)) {
				issues.push(`cockpit: header does not show the shared workflow label "${WORKFLOW_LABEL}".`)
			}
			if (joined.includes('Delegated work')) {
				issues.push('cockpit: header still shows the literal "Delegated work" title.')
			}
		} else {
			issues.push('cockpit checkpoint missing.')
		}

		// --- Assertion: nothing renders twice (the rail's top border appears
		// exactly once in the two_live_agents frame; the cockpit's own frame
		// replaces the rail rather than drawing alongside it). ---
		if (agentsRows) {
			const railBorders = agentsRows.filter((line) => line.trimStart().startsWith('┌')).length
			// One rail border plus the (possible) message-frame's own top
			// border above it — never more than two box-drawing top corners.
			if (railBorders > 2) {
				issues.push(`two_live_agents: saw ${railBorders} box top-borders — something is rendering twice.`)
			}
		}
	}

	report.frames = frames
	report.issues = issues
	report.passed = issues.length === 0

	const resultsJsonPath = join(HERE, 'tui-footer-order-results.json')
	await writeFile(resultsJsonPath, `${JSON.stringify(report, null, 2)}\n`)

	const md = renderMarkdown(report, frames)
	const resultsMdPath = join(HERE, 'tui-footer-order-results.md')
	await writeFile(resultsMdPath, md)

	console.log(JSON.stringify({ passed: report.passed, issues, root }, null, 2))
	if (!report.passed) process.exitCode = 1
}

function frameBlock(name, rows) {
	if (!rows) return `### ${name}\n\n_missing_\n`
	return `### ${name}\n\n\`\`\`\n${rows.join('\n')}\n\`\`\`\n`
}

function renderMarkdown(report, frames) {
	const lines = []
	lines.push('# TUI footer order and rail title — real-TUI verification')
	lines.push('')
	lines.push(`Date: ${report.date}`)
	lines.push('')
	lines.push(
		'Drives the actual interactive TUI under a PTY (see `tui-footer-order-drive.py` / ' +
			'`tui-footer-order-cli.mjs`) against fix commit `03f5483a`. Scripted provider spawns two ' +
			`children sharing workflow "${report.workflowLabel}" via a background \`Agent\` tool call; each ` +
			'runs `bash sleep 20` so it is still live when the screen is captured.',
	)
	lines.push('')
	lines.push(`**Result: ${report.passed ? 'PASSED' : 'MISMATCH'}**`)
	lines.push('')
	if (report.issues?.length) {
		lines.push('## Issues')
		lines.push('')
		for (const issue of report.issues) lines.push(`- ${issue}`)
		lines.push('')
	}
	lines.push('## Frames')
	lines.push('')
	for (const name of ['composer_ready', 'idle_mode_on', 'two_live_agents', 'cockpit']) {
		lines.push(frameBlock(name, frames[name]))
	}
	lines.push('## Assertions checked')
	lines.push('')
	lines.push('- `idle_mode_on`: the row directly under the message frame\'s bottom border carries the')
	lines.push('  mode badge and the `shift+tab to cycle` hint (footer text: `' + (report.footerRowIdle ?? '') + '`).')
	lines.push('- `two_live_agents`: that same footer row is unchanged, and the row directly under IT is the')
	lines.push('  rail\'s own top border (`' + (report.railTopRow ?? '') + '`) — never a rail drawn between the')
	lines.push('  frame and the footer.')
	lines.push('- The rail\'s title line is `' + (report.railTitleLine ?? '(not found)') + '` — the shared')
	lines.push(`  workflow label ("${report.workflowLabel}"), never the literal "Delegated work".`)
	lines.push('- The cockpit\'s title line (opened with ctrl+t) is `' + (report.cockpitTitleLine ?? '(not found)') + '`.')
	lines.push('- Build stability: dist files hashed before/after the run were ' + (report.buildStable ? 'IDENTICAL' : 'DIFFERENT — see JSON') + '.')
	lines.push('')
	return `${lines.join('\n')}\n`
}

await main()
