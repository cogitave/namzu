// Verifies, against the REAL interactive TUI (a genuine PTY subprocess, not a
// unit renderer), the `/orchestrate` session mode and the parent narration
// band added on top of it:
//
//   1. the effort picker (`/effort`) shows an `orchestrate` row BELOW A RULE,
//      visibly apart from the effort tokens a provider actually publishes;
//   2. selecting it turns the composer footer's `… · effort <level> ·
//      orchestrate` on, directly under the message frame's bottom border —
//      the one and only place that line is allowed to draw (see
//      `docs/cli/terminal-design.md#the-composer-footer`);
//   3. switching models (the real `/model` flow) leaves the mode on;
//   4. delegating work makes the parent narrate above the rail, bounded to
//      `MAX_RETAINED_NARRATION` lines — the oldest dropping as later ones
//      arrive — with the rail intact beneath it and the footer still
//      directly under the frame;
//   5. the literal string "Delegated work" appears nowhere in the whole run.
//
// Run at two widths (100x30 and 40x30) because (2) and (4) are exactly the
// rows `docs/cli/terminal-design.md` says degrade first under width pressure
// — a real terminal is the only trustworthy witness for what that
// degradation actually looks like.
//
// Technique (see the `cli-pty-dogfood-harness` note, and
// `tui-orchestrate-mode-drive.py`'s own header): a Python `pty`-forked driver
// runs `node packages/cli/dist/bin.js` exactly as an operator's terminal
// would — typed keystrokes with real delays — through a SCRIPTED sequence of
// steps (open the effort picker, press the digit that selects `orchestrate`,
// drive `/model`, submit a delegating prompt) and records the raw byte
// stream. A `--import` preload replaces `ProviderRegistry.create` with a
// scripted provider — the same technique `tui-footer-order-cli.mjs` and
// `narration-band-cli.mjs` use, extended here to also answer
// `reasoningEffortLevelsFor` and `listModels` so the effort picker and the
// `/model` catalog lookup resolve without ever reaching a real network.
// Checkpoints are raw byte offsets, replayed from byte 0 through a fresh
// headless VT emulator (`tui-footer-order-render.mjs`, reused unchanged).
//
// READ THE VIEWPORT, NOT BUFFER ROW 0 — see `tui-footer-order-render.mjs`
// and `narration-band-cli.mjs` for why; both readings are recorded here.

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
const DRIVER = join(HERE, 'tui-orchestrate-mode-drive.py')
const RESULTS_JSON = join(HERE, 'tui-orchestrate-mode-results.json')
const RESULTS_MD = join(HERE, 'tui-orchestrate-mode-results.md')

const CURRENT_MODEL = 'gpt-5.6-terra'
const NEXT_MODEL = 'gpt-5.6-luna'
const EFFORT_LEVELS = ['low', 'medium', 'high']
const WORKFLOW_LABEL = 'Release audit'
const PROMPT_TEXT = 'Kick off the release audit workflow.'
const SUBAGENT_SYSTEM_MARKER = 'focused sub-agent dispatched by namzu'
const NARRATION_ONE = 'scan and verify are queued; neither has started yet'
const NARRATION_TWO = 'scan and verify are running in parallel; neither has reported yet'
const NARRATION_THREE = 'scan found two unsigned artifacts — verify will re-check them first'
const NARRATION_FOUR = 'verify re-checked the two artifacts and both now pass'
const AGENT_ROWS = ['Scan release artifacts', 'Verify release artifacts']

/**
 * A prefix short enough to survive the band's own `wrap="truncate-end"` at
 * 40 columns (observed: ~33 visible characters before the row's own
 * ellipsis) — used both as the driver's "has this line landed yet" marker
 * and as the later on-screen check, so neither depends on a live line never
 * getting cut off at the narrow width this run also has to cover.
 */
const key = (text) => text.slice(0, 24)

const SIZES = [
	{ label: '100x30', cols: 100, rows: 30 },
	{ label: '40x30', cols: 40, rows: 30 },
]

// The steps every run drives, in order — see `tui-orchestrate-mode-drive.py`
// for the step schema. Shared across both widths so a difference between
// them is a fact about the terminal, never about what was typed.
const STEPS = [
	{ op: 'type_submit', text: '/effort', expect: 'Select Reasoning Level', timeout: 15, label: 'open_effort' },
	{ op: 'checkpoint', name: 'effort_picker_open' },
	// The picker applies a numbered row the instant its digit is pressed (see
	// App.tsx's `/^[1-9]$/` handling) — no arrow-key count to keep in sync
	// with the option list. `orchestrate` is the picker's LAST row: default +
	// EFFORT_LEVELS.length levels + orchestrate = 5, so its digit is "5".
	{ op: 'key', name: '5', settle: 0.6 },
	{ op: 'wait', pattern: 'Orchestrate mode is on', timeout: 15, label: 'orchestrate_on' },
	{ op: 'checkpoint', name: 'orchestrate_on' },
	{
		op: 'type_submit',
		text: `/model ${NEXT_MODEL}`,
		expect: `Switched to codex · ${NEXT_MODEL}`,
		timeout: 30,
		label: 'model_switch',
	},
	{ op: 'checkpoint', name: 'after_model_switch' },
	{
		op: 'type_submit',
		text: PROMPT_TEXT,
		expect: key(NARRATION_FOUR),
		timeout: 20,
		label: 'delegation',
	},
	{ op: 'checkpoint', name: 'narration_budget' },
]

function preloadSource() {
	return `import { ProviderRegistry, MockLLMProvider } from ${JSON.stringify(SDK_URL)}
import { CodexProvider } from ${JSON.stringify(OPENAI_PROVIDER_URL)}

const SUBAGENT_SYSTEM_MARKER = ${JSON.stringify(SUBAGENT_SYSTEM_MARKER)}
const WORKFLOW_LABEL = ${JSON.stringify(WORKFLOW_LABEL)}
const EFFORT_LEVELS = ${JSON.stringify(EFFORT_LEVELS)}
const MODEL_CATALOG = ${JSON.stringify([CURRENT_MODEL, NEXT_MODEL])}

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
				{ id: 'call-narrate-1', name: 'narrate_work', args: { line: ${JSON.stringify(NARRATION_ONE)} } },
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
	if (index === 1)
		return { toolCalls: [{ id: 'call-narrate-2', name: 'narrate_work', args: { line: ${JSON.stringify(NARRATION_TWO)} } }] }
	if (index === 2)
		return { toolCalls: [{ id: 'call-narrate-3', name: 'narrate_work', args: { line: ${JSON.stringify(NARRATION_THREE)} } }] }
	if (index === 3)
		return { toolCalls: [{ id: 'call-narrate-4', name: 'narrate_work', args: { line: ${JSON.stringify(NARRATION_FOUR)} } }] }
	if (index === 4)
		return {
			text: 'Both children are running in the background; I will report back once they finish.',
		}
	return { text: 'Understood.' }
}

ProviderRegistry.create = () => {
	const provider = new CodexProvider({ accessToken: 'fixture', accountId: 'fixture' })
	const mock = new MockLLMProvider({ nextTurn: scriptTurn })
	provider.chatStream = mock.chatStream.bind(mock)
	// Real reasoning-effort levels and a real model catalog come from a
	// network round trip (CodexProvider.listModels hits /models). Answering
	// both locally is what lets the effort picker and the real \`/model\`
	// flow resolve offline, through the SAME code paths an operator's
	// terminal uses (App.tsx -> describeProviderModels -> constructProvider
	// -> this same ProviderRegistry.create).
	provider.reasoningEffortLevelsFor = () => EFFORT_LEVELS
	provider.reasoningEffortDefaultFor = () => undefined
	provider.listModels = async () => MODEL_CATALOG.map((id) => ({ id, name: id }))
	return { provider, capabilities: provider.capabilities }
}
`
}

/** Drive one scripted session at one terminal size and return its captured frames. */
async function driveOnce(size) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-orchestrate-mode-'))
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
			providers: [{ id: 'codex', model: CURRENT_MODEL }],
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
	await writeFile(preloadPath, preloadSource())
	const capturePath = join(root, 'capture.bin')
	const driverConfigPath = join(root, 'drive-config.json')
	await writeFile(
		driverConfigPath,
		JSON.stringify({
			argv: [process.execPath, '--import', preloadPath, CLI_BIN],
			cwd: workspace,
			env: { ...process.env, NAMZU_HOME: home },
			cols: size.cols,
			rows: size.rows,
			capturePath,
			steps: STEPS,
		}),
	)

	let driveResult
	let driveError
	try {
		await exec('python3', [DRIVER, driverConfigPath], { timeout: 240_000, maxBuffer: 10_000_000 })
	} catch (error) {
		driveError = error instanceof Error ? error.message : String(error)
	}
	try {
		driveResult = JSON.parse(await readFile(`${driverConfigPath}.result.json`, 'utf8'))
	} catch (error) {
		return {
			root,
			driveError: driveError ?? String(error),
			frames: {},
			bufferTop: {},
			fullText: '',
		}
	}

	const bytes = await loadCapture(capturePath)
	const frames = {}
	const bufferTop = {}
	for (const [name, offset] of Object.entries(driveResult.checkpoints ?? {})) {
		const shared = {
			cliPackageRoot: CLI_PACKAGE_ROOT,
			bytes,
			upTo: offset,
			cols: size.cols,
			rows: size.rows,
		}
		frames[name] = await renderCheckpoint(shared)
		bufferTop[name] = await renderCheckpoint({ ...shared, fromBufferTop: true })
	}
	return { root, driveResult, ...(driveError ? { driveError } : {}), frames, bufferTop, fullText: bytes.toString('utf8') }
}

/**
 * Row index of the picker's own rule, drawn as a run of box-drawing dashes
 * INSIDE its bordered box — so the raw row also carries that box's own
 * left/right `│` and padding, which a naive "is this whole row dashes" check
 * would reject. Strip those before judging what is left.
 */
function ruleRowIndex(rows) {
	return rows.findIndex((row) => {
		const stripped = row.replace(/[│\s]/g, '')
		return stripped.length >= 8 && [...stripped].every((ch) => ch === '─')
	})
}

/** The message frame's own bottom border, then the row directly under it — the one and only footer position. */
function footerRow(rows) {
	const border = rows.findIndex((row) => row.includes('└') && row.includes('┘'))
	if (border < 0) return { error: 'message frame bottom border not on screen' }
	return { border, footer: rows[border + 1] ?? '', afterFooter: rows[border + 2] ?? '' }
}

/** The rail's own rows, top border through bottom border, found AFTER the message frame. */
function railBlock(rows) {
	const frame = rows.findIndex((row) => row.includes('└') && row.includes('┘'))
	if (frame < 0) return { error: 'message frame bottom border not on screen' }
	const top = rows.findIndex((row, index) => index > frame && row.trimStart().startsWith('┌'))
	if (top < 0) return { error: 'rail top border not on screen' }
	const bottom = rows.findIndex((row, index) => index > top && row.trimStart().startsWith('└'))
	if (bottom < 0) return { error: 'rail bottom border not on screen' }
	return { frame, top, block: rows.slice(top, bottom + 1) }
}

function checkEffortPickerOpen(rows, issues, tag) {
	if (!rows) {
		issues.push(`${tag}: no effort_picker_open frame captured`)
		return
	}
	const text = rows.join('\n')
	if (!text.includes('Select Reasoning Level'))
		issues.push(`${tag}: effort picker title not on screen`)
	const rule = ruleRowIndex(rows)
	if (rule < 0) {
		issues.push(`${tag}: no rule row found in the effort picker`)
		return
	}
	// "orchestra" rather than "orchestrate": `truncateChoiceText` clips the
	// label itself at narrow widths (40 cols renders "5. orchestra…"), and a
	// prefix that survives that is exactly as good a witness as the full word.
	const orchestrateRow = rows.findIndex((row) => row.includes('orchestra'))
	if (orchestrateRow < 0) {
		issues.push(`${tag}: no "orchestrate" row found in the effort picker`)
		return
	}
	if (orchestrateRow <= rule) issues.push(`${tag}: "orchestrate" row is not below the rule`)
	if (orchestrateRow !== rule + 1)
		issues.push(
			`${tag}: "orchestrate" is not directly under the rule (rule@${rule}, orchestrate@${orchestrateRow}): ${JSON.stringify(rows.slice(Math.max(0, rule - 1), orchestrateRow + 2))}`,
		)
	// An effort token must appear above the rule, distinct from orchestrate —
	// on its OWN numbered row ("4. high"), not just the word "high" anywhere
	// (the orchestrate row's own description legitimately says "highest level
	// and delegate by default", which also contains the substring "high").
	const highRow = rows.findIndex((row) => /\b\d\.\s*high\b/.test(row))
	if (highRow < 0 || highRow >= rule)
		issues.push(`${tag}: an effort level ("high") is not shown above the rule on its own row`)
}

/**
 * `requireOrchestrateVisible` is false below 100 columns on purpose: the
 * footer's own priority order (StatusBar.tsx's `fitStatusLine`) bundles
 * orchestrate into the SAME droppable unit as `effort` and drops that whole
 * unit, before the model, once the row does not fit — so its disappearance
 * at 40 columns is the documented, existing degradation policy running
 * exactly as written, not a fact this harness should fail a run over. It is
 * still recorded on the returned object so the caller can report it as an
 * observation.
 */
function checkFooterHasOrchestrate(rows, issues, tag, { requireEffort, requireOrchestrateVisible }) {
	if (!rows) {
		issues.push(`${tag}: no frame captured`)
		return { footer: null }
	}
	const { error, footer, afterFooter } = footerRow(rows)
	if (error) {
		issues.push(`${tag}: ${error}`)
		return { footer: null }
	}
	if (requireOrchestrateVisible && !footer.includes('orchestrate')) {
		issues.push(`${tag}: footer does not mention orchestrate: ${JSON.stringify(footer)}`)
	}
	if (requireEffort && !footer.includes('high · orchestrate'))
		issues.push(`${tag}: footer does not read "... high · orchestrate": ${JSON.stringify(footer)}`)
	if (afterFooter.trim() !== '' && !afterFooter.includes('┌'))
		issues.push(`${tag}: a non-blank, non-panel row follows the footer directly: ${JSON.stringify(afterFooter)}`)
	return { footer, mentionsOrchestrate: footer.includes('orchestrate') }
}

async function main() {
	const runs = {}
	for (const size of SIZES) runs[size.label] = await driveOnce(size)

	const issues = []
	// Real, reproducible width-dependent behavior (StatusBar's own documented
	// drop order), not a harness fault — recorded for the report rather than
	// failed as a script bug. See `checkFooterHasOrchestrate`.
	const observations = []

	for (const size of SIZES) {
		const tag = size.label
		const run = runs[tag]
		if (run.driveError) issues.push(`${tag}: driver reported an error: ${run.driveError}`)
		for (const err of run.driveResult?.errors ?? []) issues.push(`${tag}: ${err}`)

		// (1) effort picker shows orchestrate below a rule.
		checkEffortPickerOpen(run.frames.effort_picker_open, issues, `${tag} effort picker`)

		// (2) footer reads "... high · orchestrate ..." directly under the frame.
		// The combined "effort <level> · orchestrate" string is one unit that
		// drops as a whole once the row is too narrow (see StatusBar.tsx's
		// fitStatusLine) — only required verbatim at the wide size.
		const onResult = checkFooterHasOrchestrate(run.frames.orchestrate_on, issues, `${tag} orchestrate_on`, {
			requireEffort: size.cols >= 100,
			requireOrchestrateVisible: size.cols >= 100,
		})
		if (size.cols < 100 && onResult.footer !== null && !onResult.mentionsOrchestrate)
			observations.push(
				`${tag} orchestrate_on: orchestrate mode is ON but the footer shows no trace of it at this width: ${JSON.stringify(onResult.footer)}`,
			)

		// (3) the mode survives a model switch.
		const afterSwitch = run.frames.after_model_switch
		if (!afterSwitch) {
			issues.push(`${tag}: no after_model_switch frame captured`)
		} else {
			const text = afterSwitch.join('\n')
			if (!text.includes(`Switched to codex · ${NEXT_MODEL}`))
				issues.push(`${tag}: model switch confirmation not on screen`)
			if (text.includes('Select Reasoning Level'))
				issues.push(`${tag}: the effort picker reopened on top of an orchestrate-mode switch`)
			const switchResult = checkFooterHasOrchestrate(afterSwitch, issues, `${tag} after_model_switch`, {
				requireEffort: size.cols >= 100,
				requireOrchestrateVisible: size.cols >= 100,
			})
			if (size.cols < 100 && switchResult.footer !== null && !switchResult.mentionsOrchestrate)
				observations.push(
					`${tag} after_model_switch: orchestrate mode survived the switch internally, but the footer still shows no trace of it at this width: ${JSON.stringify(switchResult.footer)}`,
				)
		}

		// (4) narration band: bounded, oldest dropped, rail intact beneath it,
		// footer still directly under the frame.
		const narrationRows = run.frames.narration_budget
		if (!narrationRows) {
			issues.push(`${tag}: no narration_budget frame captured`)
		} else {
			const text = narrationRows.join('\n')
			if (text.includes(key(NARRATION_ONE)))
				issues.push(`${tag}: the oldest narration line was not dropped past the budget`)
			for (const [name, line] of [
				['NARRATION_TWO', NARRATION_TWO],
				['NARRATION_THREE', NARRATION_THREE],
				['NARRATION_FOUR', NARRATION_FOUR],
			]) {
				if (!text.includes(key(line)))
					issues.push(`${tag}: expected retained narration line missing (${name})`)
			}
			const { error: footerError, footer } = footerRow(narrationRows)
			if (footerError) issues.push(`${tag} narration_budget: ${footerError}`)
			else if (!/shift\+tab to cycle|orchestrate/.test(footer))
				issues.push(`${tag} narration_budget: footer not directly under the frame: ${JSON.stringify(footer)}`)
			const rail = railBlock(narrationRows)
			if (rail.error) {
				issues.push(`${tag} narration_budget: ${rail.error}`)
			} else {
				for (const description of AGENT_ROWS) {
					if (!rail.block.some((row) => row.includes(description)))
						issues.push(`${tag} narration_budget: rail lost the agent row "${description}"`)
				}
				if (!rail.block.some((row) => row.includes(WORKFLOW_LABEL)))
					issues.push(`${tag} narration_budget: rail lost its workflow title`)
			}
			if (text.includes('Allow narrate_work'))
				issues.push(`${tag} narration_budget: narration stopped to ask the operator for permission`)
		}

		// (5) the literal placeholder is nowhere on screen, in any frame, or
		// anywhere in the whole raw byte stream.
		if (run.fullText.includes('Delegated work'))
			issues.push(`${tag}: the literal "Delegated work" appears somewhere in the run`)
		for (const [name, rows] of Object.entries(run.frames)) {
			if (rows?.some((row) => row.includes('Delegated work')))
				issues.push(`${tag}: "Delegated work" is on screen at checkpoint ${name}`)
		}
	}

	for (const size of SIZES) {
		const run = runs[size.label]
		console.log(`\n===== ${size.label}: effort_picker_open =====`)
		console.log((run.frames.effort_picker_open ?? ['(missing)']).join('\n'))
		console.log(`\n===== ${size.label}: orchestrate_on =====`)
		console.log((run.frames.orchestrate_on ?? ['(missing)']).join('\n'))
		console.log(`\n===== ${size.label}: after_model_switch =====`)
		console.log((run.frames.after_model_switch ?? ['(missing)']).join('\n'))
		console.log(`\n===== ${size.label}: narration_budget (viewport) =====`)
		console.log((run.frames.narration_budget ?? ['(missing)']).join('\n'))
		console.log(`\n===== ${size.label}: narration_budget (buffer row 0) =====`)
		console.log((run.bufferTop.narration_budget ?? ['(missing)']).join('\n'))
	}
	console.log(`\nISSUES: ${issues.length === 0 ? 'none' : JSON.stringify(issues, null, 2)}`)
	console.log(
		`\nOBSERVATIONS (expected width-driven behavior, not a script fault): ${observations.length === 0 ? 'none' : JSON.stringify(observations, null, 2)}`,
	)

	await writeFile(
		RESULTS_JSON,
		`${JSON.stringify(
			{
				date: new Date().toISOString().slice(0, 10),
				scope:
					'Real interactive TUI under a PTY, at 100x30 and 40x30. Synthetic private workspace; scripted provider (chatStream, reasoningEffortLevelsFor, listModels), no live model, no network.',
				issues,
				observations,
				sizes: Object.fromEntries(
					SIZES.map((size) => [
						size.label,
						{
							root: runs[size.label].root,
							driveError: runs[size.label].driveError ?? null,
							driveErrors: runs[size.label].driveResult?.errors ?? [],
							frames: runs[size.label].frames,
						},
					]),
				),
			},
			null,
			2,
		)}\n`,
	)

	const mdSections = SIZES.map((size) => {
		const run = runs[size.label]
		return `## ${size.label}\n\n### effort picker open\n\n\`\`\`\n${(run.frames.effort_picker_open ?? ['(missing)']).join('\n')}\n\`\`\`\n\n### orchestrate mode on (footer)\n\n\`\`\`\n${(run.frames.orchestrate_on ?? ['(missing)']).join('\n')}\n\`\`\`\n\n### after model switch\n\n\`\`\`\n${(run.frames.after_model_switch ?? ['(missing)']).join('\n')}\n\`\`\`\n\n### narration budget (bounded, oldest dropped)\n\n\`\`\`\n${(run.frames.narration_budget ?? ['(missing)']).join('\n')}\n\`\`\`\n`
	}).join('\n')
	await writeFile(
		RESULTS_MD,
		`# Orchestrate mode + narration band, verified in the real TUI\n\nDate: ${new Date().toISOString().slice(0, 10)}\n\nScope: real interactive TUI under a PTY (\`tui-orchestrate-mode-drive.py\`, adapted from \`tui-footer-order-drive.py\`), at 100x30 and 40x30. Synthetic private workspace; scripted provider, no live model, no network.\n\n## Issues\n\n${issues.length === 0 ? 'None.' : issues.map((i) => `- ${i}`).join('\n')}\n\n## Observations (expected width-driven behavior, not a script fault)\n\n${observations.length === 0 ? 'None.' : observations.map((o) => `- ${o}`).join('\n')}\n\n${mdSections}\n`,
	)

	if (issues.length > 0) process.exitCode = 1
}

await main()
