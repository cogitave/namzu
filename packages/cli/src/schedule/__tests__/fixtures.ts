/**
 * Shared fixtures for the scheduler's tests: a private home and project, a
 * confirmed job, a recording command context, and a stubbed provider wire.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandContext } from '../../commands/types.js'
import { type DetectedProvider, PROVIDER_REGISTRY } from '../../integrations/providers/index.js'
import { type JobRequest, buildJob, confirmJob } from '../build.js'
import { type SchedulePaths, schedulePaths } from '../paths.js'
import { createJob } from '../store/jobs.js'
import type { ScheduleJob } from '../types.js'

export interface Sandbox {
	readonly root: string
	readonly home: string
	readonly osHome: string
	readonly project: string
	readonly paths: SchedulePaths
	cleanup(): void
}

export function sandbox(): Sandbox {
	const root = mkdtempSync(join(tmpdir(), 'namzu-schedule-test-'))
	const osHome = join(root, 'user')
	const home = join(osHome, '.namzu-test')
	const project = join(osHome, 'project')
	mkdirSync(home, { recursive: true })
	mkdirSync(project, { recursive: true })
	return {
		root,
		home,
		osHome,
		project,
		paths: schedulePaths(home),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	}
}

export interface Recorded {
	readonly printed: unknown[]
	readonly info: string[]
	readonly errors: string[]
}

export function recordingContext(
	config: CommandContext['config'] = {},
): CommandContext & { out: Recorded } {
	const out: Recorded = { printed: [], info: [], errors: [] }
	return {
		out,
		config,
		formatter: {
			name: 'text',
			print: (data) => out.printed.push(data),
			info: (message) => out.info.push(message),
			error: (payload) => out.errors.push(payload.message),
		},
	}
}

export function jobRequest(sb: Sandbox, over: Partial<JobRequest> = {}): JobRequest {
	return {
		name: 'nightly',
		prompt: over.runKind === 'script' ? '' : 'Check the dependencies.',
		when: '0 3 * * *',
		folder: sb.project,
		tz: 'UTC',
		permissions: { preset: 'read-only' },
		...(over.runKind === 'script' ? {} : { model: 'deepseek/deepseek-chat' }),
		createdBy: { surface: 'cli' },
		...over,
	}
}

/** A job confirmed on a terminal and written to the store. */
export function confirmedJob(
	sb: Sandbox,
	over: Partial<JobRequest> = {},
	now = new Date(),
): ScheduleJob {
	const built = buildJob(jobRequest(sb, over), {
		paths: sb.paths,
		config: {},
		now,
		osHome: sb.osHome,
	})
	return createJob(sb.paths, confirmJob(built, 'cli-tty', now))
}

export const DEEPSEEK: DetectedProvider = {
	entry: PROVIDER_REGISTRY.deepseek,
	source: { kind: 'env', envName: 'DEEPSEEK_API_KEY' },
	apiKey: 'not-a-real-key',
	alternatives: [],
}

/** One streamed chat completion: a text answer, or one tool call. */
export function completion(tool?: {
	readonly name: string
	readonly input: unknown
	readonly id?: string
}): Response {
	const chunk = {
		id: 'chatcmpl-schedule-fixture',
		object: 'chat.completion.chunk',
		created: 1,
		model: 'deepseek-chat',
		choices: [
			{
				index: 0,
				delta: tool
					? {
							tool_calls: [
								{
									index: 0,
									id: tool.id ?? 'call_1',
									type: 'function',
									function: {
										name: tool.name,
										arguments: JSON.stringify(tool.input),
									},
								},
							],
						}
					: { content: 'All dependencies are current.\nDetails follow.' },
				finish_reason: tool ? 'tool_calls' : 'stop',
			},
		],
		usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
	}
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	})
}
