import { z } from 'zod'
import type { ToolContext, ToolDefinition, ToolResult } from '../../types/tool/index.js'
import { canonicalizeBrowserSitePattern } from '../builtins/browser-url.js'
import { defineTool } from '../defineTool.js'
import { presentScheduleCall, presentScheduleResult } from './present.js'
import { scanSchedulePrompt } from './prompt-scan.js'
import type {
	ScheduleBrowserGrant,
	ScheduleBrowserSiteLevel,
	ScheduleJobChanges,
	ScheduleJobDraft,
	ScheduleJobUpdateProposal,
	ScheduleToolHost,
} from './types.js'

export const SCHEDULE_TOOL_NAME = 'schedule'

/**
 * A person reads the whole proposal — the prompt, the rules, the schedule,
 * the credential source — before answering `create`, `update`, `resume` or
 * `delete`.
 * The executor's `DEFAULT_TOOL_TIMEOUT_MS` (two minutes) is sized for a tool
 * call, not a person on the other end of a screen, and would abandon the
 * call out from under them mid-read. `save_skill`
 * (`packages/cli/src/skills/save.ts`) waits on the same kind of answer and
 * uses the same thirty minutes, for the same reason.
 */
const OPERATOR_CONFIRM_TIMEOUT_MS = 30 * 60_000

const EFFECT = z.enum(['allow', 'ask', 'deny'])
const NETWORK_TOOLS = ['web_fetch', 'web_search']
const BROWSER_PROFILE = /^[a-z0-9][a-z0-9-]{0,62}$/

const inputSchema = z.object({
	action: z
		.enum(['create', 'list', 'update', 'pause', 'resume', 'delete'])
		.describe(
			'What to do. create, update, resume and delete ask the operator first. To change a job, update it: deleting and creating it again loses its history.',
		),
	name: z
		.string()
		.regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
		.optional()
		.describe('create: job name, lowercase letters, digits and dashes'),
	kind: z
		.enum(['agent', 'script', 'script+agent'])
		.optional()
		.describe(
			'create: what the run does. agent (default): the model runs prompt. script: a fixed shell script runs unattended, no model call, no prompt. script+agent: a cheap gate script decides whether to wake the model; wake:false costs nothing. Prefer script/script+agent for a fixed, deterministic check that would otherwise cost tokens for no reason.',
		),
	script: z
		.object({
			body: z.string().min(1).describe('The exact script text, run verbatim once confirmed'),
			shell: z.enum(['bash', 'sh']).describe('Which shell reads it; no default'),
			timeoutMs: z.number().int().positive().optional().describe('The script’s own wall clock'),
		})
		.optional()
		.describe(
			'create: required when kind is script or script+agent. For script+agent this is the wake-gate: its stdout must be exactly one JSON line, {"wake": boolean, "context": string}.',
		),
	prompt: z
		.string()
		.min(1)
		.max(20_000)
		.optional()
		.describe(
			'create, update: what the run is asked to do. Required unless kind is script (unused there); for script+agent this is the instruction handed to the model only when the wake-gate says wake: true.',
		),
	when: z
		.string()
		.optional()
		.describe('create, update: "every 30m", "0 9 * * 1-5" (cron), "at 2026-09-24 09:00", "in 2h"'),
	folder: z
		.string()
		.optional()
		.describe("create: folder to run in; leave unset for the session's unless the user named one"),
	tz: z
		.string()
		.optional()
		.describe(
			"create: IANA time zone; leave unset for the operator's own zone unless the user named another",
		),
	permissions: z
		.object({
			preset: z
				.enum(['read-only', 'edit-in-folder'])
				.optional()
				.describe(
					'read-only: read/glob/grep/ls only. edit-in-folder: also edit and write, bash asks',
				),
			unmatched: z
				.enum(['park', 'deny'])
				.describe('A call no rule covers: park (wait for the operator) or deny'),
			execution: z
				.enum(['host', 'sandbox'])
				.optional()
				.describe(
					'Where commands run; leave unset (this machine) unless the user asked for a sandbox',
				),
			rules: z
				.record(z.string(), z.union([EFFECT, z.record(z.string(), EFFECT)]))
				.optional()
				.describe('Extra rules, e.g. {"bash": {"npm test*": "allow"}}'),
			browser: z
				.object({
					profile: z
						.string()
						.regex(BROWSER_PROFILE)
						.describe('Browser profile the operator signed in with, e.g. "work"'),
					sites: z
						.record(z.string(), z.enum(['read', 'ask', 'act']))
						.describe(
							'Site to level, e.g. {"https://github.com": "read"}. read: open and read only; ask: changes wait for the operator; act: changes run unasked. Unlisted sites are denied; there is no "*".',
						),
					headed: z.boolean().optional().describe('Show the browser window; default no window'),
				})
				.optional()
				.describe('Browser access; omit for none'),
		})
		.optional()
		.describe(
			'create: REQUIRED explicit permission set; there is no default. update: the whole new set, only when the permissions change',
		),
	budget: z
		.object({
			maxIterations: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'Model steps one run may take (each model call with its tool calls is one step), not how many times the job runs. Omit for the default; a browser task takes 10 or more.',
				),
			tokenBudget: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'Tokens one run may spend in total. Every model call resends the whole prompt (often 10,000-30,000 tokens each), so a run needs far more than its answer; omit for the default.',
				),
			timeoutMs: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Wall clock of one run, in milliseconds'),
		})
		.optional()
		.describe('Limits of ONE run; omit to use the defaults'),
	job: z.string().optional().describe('update/pause/resume/delete: job name'),
	allFolders: z.boolean().optional().describe('list: include jobs of other folders (names only)'),
})

type Input = z.infer<typeof inputSchema>

function refuse(error: string): ToolResult {
	return { success: false, output: '', error }
}

function effectsOf(rule: unknown): string[] {
	if (typeof rule === 'string') return [rule]
	if (rule && typeof rule === 'object') return Object.values(rule as Record<string, string>)
	return []
}

/**
 * Refuse a network tool beside a shell that runs on the host: a scheduled run
 * that can both read the machine and reach the internet, unattended, is the
 * exfiltration shape, and only the operator can choose it.
 *
 * For `runKind: 'script'`/`'script+agent'` the "shell" isn't a rule the model
 * could reach at some later live call — it's the confirmed script's own
 * body, which unconditionally runs shell commands whenever it runs at all.
 * The `bash` rule heuristic below answers a question ("could a live call
 * reach bash") that isn't the one being asked here, so a script/script+agent
 * job on the host is treated as reaching a shell outright, whatever its
 * rules say about `bash`.
 */
function networkWithHostShell(draft: ScheduleJobDraft): boolean {
	const rules = draft.permissions.rules ?? {}
	const network =
		draft.permissions.browser !== undefined ||
		NETWORK_TOOLS.some((t) => effectsOf(rules[t]).some((e) => e === 'allow' || e === 'ask'))
	if (!network) return false
	const onHost = (draft.permissions.execution ?? 'host') === 'host'
	if ((draft.runKind ?? 'agent') !== 'agent') return onHost
	const bashEffects = effectsOf(rules.bash)
	// The read-only preset denies bash; its rules are expanded by the host,
	// so the draft carries only its name.
	const shellPossible =
		bashEffects.length > 0
			? bashEffects.some((e) => e !== 'deny')
			: draft.permissions.preset !== 'read-only' && draft.permissions.unmatched !== 'deny'
	return shellPossible && onHost
}

/**
 * The browser grant with its site keys canonicalised, or why it is refused.
 * Keys are rewritten so the host, the confirmation and the compiled rules
 * all see one spelling of each site.
 */
function browserGrant(
	host: ScheduleToolHost,
	proposed: NonNullable<NonNullable<Input['permissions']>['browser']>,
): { ok: true; grant: ScheduleBrowserGrant } | { ok: false; error: string } {
	if (host.browserGrants !== true) {
		return {
			ok: false,
			error:
				'This host cannot give a scheduled job browser access. Propose the job without permissions.browser, or ask the operator to add it with `namzu schedule add`.',
		}
	}
	const entries = Object.entries(proposed.sites)
	if (entries.length === 0) {
		return {
			ok: false,
			error:
				'permissions.browser.sites is empty; list each site the run may open, e.g. {"https://github.com": "read"}.',
		}
	}
	const sites: Record<string, ScheduleBrowserSiteLevel> = {}
	for (const [key, level] of entries) {
		if (key.trim() === '*') {
			return {
				ok: false,
				error:
					'A scheduled job cannot grant every site ("*"); unlisted sites are always denied. List each site.',
			}
		}
		const verdict = canonicalizeBrowserSitePattern(key)
		if (!verdict.ok) return { ok: false, error: `permissions.browser.sites: ${verdict.reason}` }
		if (verdict.pattern in sites && sites[verdict.pattern] !== level) {
			return {
				ok: false,
				error: `permissions.browser.sites names ${verdict.pattern} twice with different levels.`,
			}
		}
		sites[verdict.pattern] = level
	}
	return {
		ok: true,
		grant: {
			profile: proposed.profile,
			sites,
			...(proposed.headed !== undefined ? { headed: proposed.headed } : {}),
		},
	}
}

/** A proposed permission set as a draft carries it, or why it is refused. */
function checkPermissions(
	host: ScheduleToolHost,
	proposed: NonNullable<Input['permissions']>,
): { ok: true; permissions: ScheduleJobDraft['permissions'] } | { ok: false; error: string } {
	if (!proposed.preset && !proposed.rules && !proposed.browser) {
		return {
			ok: false,
			error:
				'permissions needs a preset, rules or a browser grant; an empty permission set is not a choice.',
		}
	}
	if (!proposed.browser) return { ok: true, permissions: proposed }
	const grant = browserGrant(host, proposed.browser)
	if (!grant.ok) return grant
	return { ok: true, permissions: { ...proposed, browser: grant.grant } }
}

const NETWORK_WITH_HOST_SHELL =
	'A scheduled job proposed here cannot combine web or browser access with a shell on the host. Deny bash, use execution "sandbox", or ask the operator to create it with `namzu schedule add`.'

async function create(
	host: ScheduleToolHost,
	input: Input,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	const runKind = input.kind ?? 'agent'
	const required: string[] = (['name', 'when', 'permissions'] as const).filter(
		(k) => input[k] === undefined,
	)
	if (runKind !== 'script' && input.prompt === undefined) required.push('prompt')
	if (runKind !== 'agent' && input.script === undefined) required.push('script')
	if (required.length > 0) {
		return refuse(
			`create needs ${required.join(', ')}. permissions is required: propose an explicit set (a preset and/or rules, plus unmatched).`,
		)
	}
	if (runKind === 'agent' && input.script !== undefined) {
		return refuse('an agent job has no script; omit kind (or set it to agent) to use one')
	}
	const checked = checkPermissions(host, input.permissions as NonNullable<Input['permissions']>)
	if (!checked.ok) return refuse(checked.error)
	const permissions = checked.permissions
	const draft: ScheduleJobDraft = {
		name: input.name as string,
		when: input.when as string,
		...(runKind !== 'agent' ? { runKind } : {}),
		...(input.script ? { script: input.script } : {}),
		...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
		...(input.folder !== undefined ? { folder: input.folder } : {}),
		...(input.tz !== undefined ? { tz: input.tz } : {}),
		permissions,
		...(input.budget ? { budget: input.budget } : {}),
	}
	if (networkWithHostShell(draft)) return refuse(NETWORK_WITH_HOST_SHELL)
	let preview: Awaited<ReturnType<ScheduleToolHost['preview']>>
	try {
		preview = await host.preview(draft)
	} catch (error) {
		return refuse(error instanceof Error ? error.message : String(error))
	}
	let answer: string
	try {
		answer = await host.confirm(
			{
				preview,
				promptFindings: scanSchedulePrompt(preview.prompt),
				proposedBy: 'model',
			},
			signal,
		)
	} catch {
		answer = 'cancel'
	}
	// The deadline or the turn can settle `host.confirm` from underneath a
	// host that resolves optimistically on its own close; never create on an
	// answer that arrived after the operator was no longer being asked.
	if (signal?.aborted) answer = 'cancel'
	if (answer !== 'create' && answer !== 'create-paused') {
		return {
			success: false,
			output: '',
			error: 'The operator did not confirm the job, so it was not created.',
			data: { cancelled: true },
		}
	}
	const created = await host.create(draft, preview, { paused: answer === 'create-paused' })
	const said =
		answer === 'create-paused'
			? `Job "${created.name}" was created paused. The operator can resume it with /schedule.`
			: `Job "${created.name}" was created. It runs ${preview.schedule}, with nobody watching; results arrive as a notification and a session.`
	return {
		success: true,
		output: created.note ? `${said} ${created.note}` : said,
		data: { name: created.name, paused: answer === 'create-paused' },
	}
}

async function list(host: ScheduleToolHost, input: Input): Promise<ToolResult> {
	const jobs = await host.list({ allFolders: input.allFolders === true })
	if (jobs.length === 0) return { success: true, output: 'No scheduled jobs.', data: { jobs: [] } }
	const lines = jobs.map(
		(j) =>
			`${j.name} · ${j.state} · ${j.schedule}${j.nextFireAt ? ` · next ${j.nextFireAt}` : ''}${j.lastStatus ? ` · last ${j.lastStatus}` : ''} · ${j.folder}${j.inSessionFolder ? ' (this folder)' : ''}`,
	)
	return { success: true, output: lines.join('\n'), data: { jobs } }
}

/** The fields `update` may change, as the model set them. */
const CHANGEABLE = ['prompt', 'when', 'folder', 'tz', 'permissions', 'budget'] as const

async function update(
	host: ScheduleToolHost,
	input: Input,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	if (!host.previewUpdate || !host.confirmUpdate || !host.update) {
		return refuse(
			'This host cannot change a scheduled job. Ask the operator to change it themselves; do not delete and create it again, which loses its history.',
		)
	}
	if (!input.job) return refuse("update needs job (the job's name) and the fields to change.")
	if (input.name !== undefined) {
		return refuse(
			'update cannot rename a job: name the job to change with job, and leave name out.',
		)
	}
	const given = CHANGEABLE.filter((k) => input[k] !== undefined)
	if (given.length === 0) {
		return refuse(`update needs at least one of ${CHANGEABLE.join(', ')} to change.`)
	}
	let permissions: ScheduleJobDraft['permissions'] | undefined
	if (input.permissions) {
		const checked = checkPermissions(host, input.permissions)
		if (!checked.ok) return refuse(checked.error)
		permissions = checked.permissions
		if (networkWithHostShell({ name: '', prompt: '', when: '', permissions }))
			return refuse(NETWORK_WITH_HOST_SHELL)
	}
	const changes: ScheduleJobChanges = {
		...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
		...(input.when !== undefined ? { when: input.when } : {}),
		...(input.folder !== undefined ? { folder: input.folder } : {}),
		...(input.tz !== undefined ? { tz: input.tz } : {}),
		...(permissions ? { permissions } : {}),
		...(input.budget ? { budget: input.budget } : {}),
	}
	let proposal: ScheduleJobUpdateProposal
	try {
		proposal = await host.previewUpdate(input.job, changes)
	} catch (error) {
		return refuse(error instanceof Error ? error.message : String(error))
	}
	let confirmed = false
	try {
		confirmed = await host.confirmUpdate(
			{
				...proposal,
				promptFindings: scanSchedulePrompt(proposal.preview.prompt),
				proposedBy: 'model',
			},
			signal,
		)
	} catch {
		confirmed = false
	}
	// As for `create`: never save on an answer that came after the
	// operator was no longer being asked.
	if (signal?.aborted) confirmed = false
	if (!confirmed) {
		return {
			...refuse(
				`The operator did not confirm the change; "${proposal.preview.name}" was not changed.`,
			),
			data: { cancelled: true },
		}
	}
	let saved: Awaited<ReturnType<NonNullable<ScheduleToolHost['update']>>>
	try {
		saved = await host.update(proposal.preview)
	} catch (error) {
		return refuse(error instanceof Error ? error.message : String(error))
	}
	const said = `Job "${saved.name}" was updated in place and keeps its history. It runs ${proposal.preview.schedule}.`
	return {
		success: true,
		output: saved.note ? `${said} ${saved.note}` : said,
		data: { name: saved.name, updated: true, changes: proposal.changes },
	}
}

async function lifecycle(
	host: ScheduleToolHost,
	input: Input,
	action: 'pause' | 'resume' | 'delete',
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	if (!input.job) return refuse(`${action} needs job (the job's name).`)
	const job = await host.find(input.job)
	if (!job) return refuse(`No scheduled job is named "${input.job}".`)
	if (action !== 'pause') {
		let confirmed = false
		try {
			confirmed = await host.confirmAction(job, action, signal)
		} catch {
			confirmed = false
		}
		if (signal?.aborted) confirmed = false
		if (!confirmed)
			return {
				...refuse(`The operator did not confirm; "${job.name}" was not changed.`),
				data: { cancelled: true },
			}
	}
	if (action === 'pause') await host.pause(job.name)
	else if (action === 'resume') await host.resume(job.name)
	else await host.delete(job.name)
	const verb = action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'deleted'
	return { success: true, output: `Job "${job.name}" ${verb}.`, data: { name: job.name, action } }
}

/**
 * The `schedule` tool: create, list, update, pause, resume and delete the
 * operator's scheduled jobs from a conversation.
 *
 * Creation, updating, resuming and deleting are confirmed by a person
 * through the host (`ScheduleToolHost.confirm`, `confirmUpdate`), on a
 * screen the host draws from its own computation. An update changes the
 * job in place, so it keeps its id and its history. The model cannot propose that uncovered calls run without
 * asking, nor web access beside a host shell. Register it only where a person
 * is present to confirm: never in a headless run, a scheduled run or a
 * sub-agent.
 */
export function buildScheduleTools(host: ScheduleToolHost): ToolDefinition[] {
	return [
		defineTool({
			name: SCHEDULE_TOOL_NAME,
			description:
				"Manage the operator's scheduled jobs: prompts that run later in a folder, with nobody watching, under an explicit permission set. Use it only when the user asks for something to happen on a schedule. create, update, resume and delete are confirmed by the operator; pause is not. A job needs name, prompt, when and permissions (unmatched: park or deny, plus a preset, rules or a browser grant). To change a job, update it with job and only the fields that change; do not delete and recreate it. Leave every other field (folder, tz, execution, budget, headed) unset unless the user asked for it: the defaults are the operator's, and the confirmation marks each value you chose. Scheduled runs cannot ask questions.",
			inputSchema,
			category: 'custom',
			permissions: [],
			readOnly: (input) => input.action === 'list',
			// `delete` removes a job only after the operator confirms it on the
			// host's own screen; a destructive flag would put a second review,
			// over the raw arguments, in front of that confirmation.
			destructive: false,
			concurrencySafe: false,
			presentCall: presentScheduleCall,
			presentResult: presentScheduleResult,
			// A person, not a tool, answers `create`/`update`/`resume`/`delete`;
			// see `OPERATOR_CONFIRM_TIMEOUT_MS`.
			timeoutMs: OPERATOR_CONFIRM_TIMEOUT_MS,
			async execute(input, context: ToolContext) {
				switch (input.action) {
					case 'create':
						return create(host, input, context.abortSignal)
					case 'list':
						return list(host, input)
					case 'update':
						return update(host, input, context.abortSignal)
					default:
						return lifecycle(host, input, input.action, context.abortSignal)
				}
			},
		}),
	]
}
