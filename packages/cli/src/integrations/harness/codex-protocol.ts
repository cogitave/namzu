import type {
	HarnessEvent,
	HarnessJson,
	HarnessModel,
	HarnessNativeTurn,
	ReasoningEffort,
	ReviewMode,
} from '@namzu/sdk'

export function codexRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

export function codexString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

const efforts: readonly ReasoningEffort[] = [
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra',
]

/** A catalogue row may also say it is the engine's own recommended default. */
export type HarnessCatalogueModel = HarnessModel & { readonly default?: true }

/** The Codex app writes "GPT-5.6 Sol" where its server says "GPT-5.6-Sol". */
export function codexModelLabel(name: string): string {
	return name.replace(/^(.*\d)-([A-Za-z][A-Za-z0-9]*)$/, '$1 $2')
}

export function parseCodexModels(rows: unknown): HarnessCatalogueModel[] {
	if (!Array.isArray(rows)) throw new Error('Codex returned an invalid model catalogue.')
	const seen = new Set<string>()
	return [...rows]
		.sort(
			(a, b) =>
				Number(codexRecord(b)?.isDefault === true) - Number(codexRecord(a)?.isDefault === true),
		)
		.flatMap((raw) => {
			const row = codexRecord(raw)
			const id = codexString(row?.model) ?? codexString(row?.id)
			if (!row || !id || seen.has(id) || row.hidden === true) return []
			seen.add(id)
			const offered = Array.isArray(row.supportedReasoningEfforts)
				? row.supportedReasoningEfforts.flatMap((option) => {
						const effort = codexRecord(option)?.reasoningEffort
						return efforts.includes(effort as ReasoningEffort) ? [effort as ReasoningEffort] : []
					})
				: []
			const defaultEffort = offered.includes(row.defaultReasoningEffort as ReasoningEffort)
				? (row.defaultReasoningEffort as ReasoningEffort)
				: undefined
			const displayName = codexString(row.displayName)
			return [
				{
					id,
					label: displayName ? codexModelLabel(displayName) : id,
					effortLevels: offered,
					defaultEffort,
					...(row.isDefault === true ? { default: true as const } : {}),
				},
			]
		})
}

/** Modes never turn the user's default Ask first into full filesystem access. */
export function codexPermissionConfig(
	mode: ReviewMode,
	cwd: string,
): {
	approvalPolicy: 'untrusted' | 'on-request' | 'never'
	sandboxPolicy: HarnessJson
} {
	if (mode === 'plan' || mode === 'strict')
		return { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
	if (mode === 'auto')
		return { approvalPolicy: 'on-request', sandboxPolicy: { type: 'dangerFullAccess' } }
	if (mode === 'accept-edits')
		return {
			approvalPolicy: 'untrusted',
			sandboxPolicy: {
				type: 'workspaceWrite',
				writableRoots: [cwd],
				networkAccess: false,
				excludeTmpdirEnvVar: true,
				excludeSlashTmp: true,
			},
		}
	return { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
}

export function codexJson(value: unknown): HarnessJson {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (Array.isArray(value)) return Object.freeze(value.map(codexJson))
	const record = codexRecord(value)
	if (record)
		return Object.freeze(
			Object.fromEntries(
				Object.entries(record)
					.filter(([, entry]) => entry !== undefined)
					.map(([key, entry]) => [key, codexJson(entry)]),
			),
		)
	return null
}

/** Public native items only; reasoning replay/content is deliberately not copied. */
export function codexItemEvents(
	turn: HarnessNativeTurn,
	raw: unknown,
	completed: boolean,
): HarnessEvent[] {
	const item = codexRecord(raw)
	const nativeItemId = codexString(item?.id)
	if (!item || !nativeItemId) return []
	const identity = { ...turn, nativeItemId }
	if (item.type === 'agentMessage') {
		if (!completed) return [{ ...identity, kind: 'message-started' }]
		const text = typeof item.text === 'string' ? item.text : ''
		const phase =
			item.phase === 'commentary' || item.phase === 'final_answer' ? item.phase : undefined
		return [
			{
				...identity,
				kind: 'message-completed',
				content: text,
				parts: [{ id: nativeItemId, text, phase }],
				stopReason: 'end_turn',
			},
		]
	}
	if (item.type === 'reasoning') {
		const summary = Array.isArray(item.summary)
			? item.summary.filter((part): part is string => typeof part === 'string')
			: []
		return (summary.length ? summary : ['']).map((text, index) => ({
			...identity,
			kind: 'reasoning',
			blockId: `${nativeItemId}:${index}`,
			status: completed ? 'completed' : 'pending',
			...(text ? { text } : {}),
		}))
	}
	let name: string | undefined
	let input: HarnessJson = null
	let result = ''
	if (item.type === 'commandExecution') {
		name = 'exec_command'
		input = codexJson({ command: item.command, cwd: item.cwd })
		result = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
	} else if (item.type === 'fileChange') {
		name = 'apply_patch'
		input = codexJson({ changes: item.changes })
	} else if (item.type === 'mcpToolCall') {
		name = `${codexString(item.server) ?? 'mcp'}.${codexString(item.tool) ?? 'tool'}`
		input = codexJson(item.arguments)
		result = JSON.stringify(codexJson(item.result ?? item.error))
	} else if (item.type === 'dynamicToolCall') {
		name = codexString(item.tool) ?? 'dynamic_tool'
		input = codexJson(item.arguments)
		result = JSON.stringify(codexJson(item.contentItems))
	} else if (item.type === 'webSearch') {
		name = 'web_search'
		input = codexJson(item.action)
	} else if (item.type === 'collabAgentToolCall') {
		name = codexString(item.tool) ?? 'collaboration'
		input = codexJson({
			receiverThreadIds: item.receiverThreadIds,
			prompt: item.prompt,
			model: item.model,
		})
		result = JSON.stringify(codexJson(item.agentsStates))
	}
	if (!name) return []
	if (!completed) return [{ ...identity, kind: 'tool-started', name, input }]
	const status =
		item.status === 'failed' || item.success === false
			? 'failed'
			: item.status === 'declined'
				? 'declined'
				: item.status === 'cancelled'
					? 'cancelled'
					: 'completed'
	return [
		{
			...identity,
			kind: 'tool-completed',
			name,
			result,
			status,
			...(typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {}),
		},
	]
}

export function codexTerminalEvent(
	turn: HarnessNativeTurn,
	value: unknown,
): HarnessEvent | undefined {
	const raw = codexRecord(value)
	if (!raw || !['completed', 'interrupted', 'failed'].includes(String(raw.status))) return undefined
	return {
		...turn,
		kind: 'turn-completed',
		status:
			raw.status === 'interrupted' ? 'cancelled' : raw.status === 'failed' ? 'failed' : 'completed',
		...(raw.status === 'failed'
			? { error: { code: 'codex-turn-failed', message: 'Codex could not complete this turn.' } }
			: {}),
	}
}
