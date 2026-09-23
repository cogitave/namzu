import { z } from 'zod'
import type { ToolDefinition, ToolResult } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'
import { presentScheduleCall, presentScheduleResult } from './present.js'
import { scanSchedulePrompt } from './prompt-scan.js'
import type { ScheduleJobDraft, ScheduleToolHost } from './types.js'

export const SCHEDULE_TOOL_NAME = 'schedule'

const EFFECT = z.enum(['allow', 'ask', 'deny'])
const NETWORK_TOOLS = ['web_fetch', 'web_search']

const inputSchema = z.object({
	action: z
		.enum(['create', 'list', 'pause', 'resume', 'delete'])
		.describe('What to do. create, resume and delete ask the operator first.'),
	name: z
		.string()
		.regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
		.optional()
		.describe('create: job name, lowercase letters, digits and dashes'),
	prompt: z.string().min(1).max(20_000).optional().describe('create: what the run is asked to do'),
	when: z
		.string()
		.optional()
		.describe('create: "every 30m", "0 9 * * 1-5" (cron), "at 2026-09-24 09:00", "in 2h"'),
	folder: z.string().optional().describe("create: folder to run in; default the session's"),
	tz: z.string().optional().describe('create: IANA time zone; default the host zone'),
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
			execution: z.enum(['host', 'sandbox']).optional(),
			rules: z
				.record(z.string(), z.union([EFFECT, z.record(z.string(), EFFECT)]))
				.optional()
				.describe('Extra rules, e.g. {"bash": {"npm test*": "allow"}}'),
		})
		.optional()
		.describe('create: REQUIRED explicit permission set; there is no default'),
	budget: z
		.object({
			maxIterations: z.number().int().positive().optional(),
			tokenBudget: z.number().int().positive().optional(),
			timeoutMs: z.number().int().positive().optional(),
		})
		.optional(),
	job: z.string().optional().describe('pause/resume/delete: job name'),
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
 */
function networkWithHostShell(draft: ScheduleJobDraft): boolean {
	const rules = draft.permissions.rules ?? {}
	const network = NETWORK_TOOLS.some((t) =>
		effectsOf(rules[t]).some((e) => e === 'allow' || e === 'ask'),
	)
	if (!network) return false
	const bashEffects = effectsOf(rules.bash)
	const shellPossible =
		bashEffects.length > 0
			? bashEffects.some((e) => e !== 'deny')
			: draft.permissions.unmatched !== 'deny'
	return shellPossible && (draft.permissions.execution ?? 'host') === 'host'
}

async function create(host: ScheduleToolHost, input: Input): Promise<ToolResult> {
	const missing = (['name', 'prompt', 'when', 'permissions'] as const).filter(
		(k) => input[k] === undefined,
	)
	if (missing.length > 0) {
		return refuse(
			`create needs ${missing.join(', ')}. permissions is required: propose an explicit set (a preset and/or rules, plus unmatched).`,
		)
	}
	const permissions = input.permissions as NonNullable<Input['permissions']>
	if (!permissions.preset && !permissions.rules) {
		return refuse('permissions needs a preset or rules; an empty permission set is not a choice.')
	}
	const draft: ScheduleJobDraft = {
		name: input.name as string,
		prompt: input.prompt as string,
		when: input.when as string,
		...(input.folder !== undefined ? { folder: input.folder } : {}),
		...(input.tz !== undefined ? { tz: input.tz } : {}),
		permissions,
		...(input.budget ? { budget: input.budget } : {}),
	}
	if (networkWithHostShell(draft)) {
		return refuse(
			'A scheduled job proposed here cannot combine web access with a shell on the host. Deny bash, use execution "sandbox", or ask the operator to create it with `namzu schedule add`.',
		)
	}
	let preview: Awaited<ReturnType<ScheduleToolHost['preview']>>
	try {
		preview = await host.preview(draft)
	} catch (error) {
		return refuse(error instanceof Error ? error.message : String(error))
	}
	let answer: string
	try {
		answer = await host.confirm({
			preview,
			promptFindings: scanSchedulePrompt(preview.prompt),
			proposedBy: 'model',
		})
	} catch {
		answer = 'cancel'
	}
	if (answer !== 'create' && answer !== 'create-paused') {
		return {
			success: false,
			output: '',
			error: 'The operator did not confirm the job, so it was not created.',
		}
	}
	const created = await host.create(draft, preview, { paused: answer === 'create-paused' })
	return {
		success: true,
		output:
			answer === 'create-paused'
				? `Job "${created.name}" was created paused. The operator can resume it with /schedule.`
				: `Job "${created.name}" was created. It runs ${preview.schedule}, with nobody watching; results arrive as a notification and a session.`,
		data: { name: created.name, paused: answer === 'create-paused' },
	}
}

async function list(host: ScheduleToolHost, input: Input): Promise<ToolResult> {
	const jobs = await host.list({ allFolders: input.allFolders === true })
	if (jobs.length === 0) return { success: true, output: 'No scheduled jobs.', data: { jobs: [] } }
	const lines = jobs.map(
		(j) =>
			`${j.name} · ${j.state} · ${j.schedule}${j.nextFireAt ? ` · next ${j.nextFireAt}` : ''}${j.lastStatus ? ` · last ${j.lastStatus}` : ''} · ${j.folder}`,
	)
	return { success: true, output: lines.join('\n'), data: { jobs } }
}

async function lifecycle(
	host: ScheduleToolHost,
	input: Input,
	action: 'pause' | 'resume' | 'delete',
): Promise<ToolResult> {
	if (!input.job) return refuse(`${action} needs job (the job's name).`)
	const job = await host.find(input.job)
	if (!job) return refuse(`No scheduled job is named "${input.job}".`)
	if (action !== 'pause') {
		let confirmed = false
		try {
			confirmed = await host.confirmAction(job, action)
		} catch {
			confirmed = false
		}
		if (!confirmed) return refuse(`The operator did not confirm; "${job.name}" was not changed.`)
	}
	if (action === 'pause') await host.pause(job.name)
	else if (action === 'resume') await host.resume(job.name)
	else await host.delete(job.name)
	const verb = action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'deleted'
	return { success: true, output: `Job "${job.name}" ${verb}.`, data: { name: job.name, action } }
}

/**
 * The `schedule` tool: create, list, pause, resume and delete the operator's
 * scheduled jobs from a conversation.
 *
 * Creation, resuming and deleting are confirmed by a person through the host
 * (`ScheduleToolHost.confirm`), on a screen the host draws from its own
 * computation. The model cannot propose that uncovered calls run without
 * asking, nor web access beside a host shell. Register it only where a person
 * is present to confirm: never in a headless run, a scheduled run or a
 * sub-agent.
 */
export function buildScheduleTools(host: ScheduleToolHost): ToolDefinition[] {
	return [
		defineTool({
			name: SCHEDULE_TOOL_NAME,
			description:
				"Manage the operator's scheduled jobs: prompts that run later in a folder, with nobody watching, under an explicit permission set. Use it only when the user asks for something to happen on a schedule. create, resume and delete are confirmed by the operator; pause is not. A job needs name, prompt, when and permissions (unmatched: park or deny, plus a preset or rules). Scheduled runs cannot ask questions.",
			inputSchema,
			category: 'custom',
			permissions: [],
			readOnly: (input) => input.action === 'list',
			destructive: (input) => input.action === 'delete',
			concurrencySafe: false,
			presentCall: presentScheduleCall,
			presentResult: presentScheduleResult,
			async execute(input) {
				switch (input.action) {
					case 'create':
						return create(host, input)
					case 'list':
						return list(host, input)
					default:
						return lifecycle(host, input, input.action)
				}
			},
		}),
	]
}
