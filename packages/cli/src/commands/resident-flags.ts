import { isPermissionMode } from '../permissions/mode.js'
import { type RunFlags, parseRunFlags } from './run-flags.js'

const actions = ['add', 'status', 'run', 'pause', 'resume', 'wake', 'reconcile', 'archive'] as const
export type ResidentAction = (typeof actions)[number]

export interface ResidentFlags {
	readonly action: ResidentAction
	readonly agent: string
	readonly maxSteps: number | null
	readonly maxIdleMs: number
	readonly claim: string | null
	readonly revision: number | null
	readonly outcome: 'wait' | 'complete' | 'blocked' | null
	readonly executorStopped: boolean
	readonly run: RunFlags
}

function integer(value: string, flag: string, zero = false): number {
	const parsed = Number(value)
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < (zero ? 0 : 1))
		throw new Error(`${flag} requires a ${zero ? 'nonnegative' : 'positive'} whole number.`)
	return parsed
}

export function parseResidentFlags(raw: readonly string[]): ResidentFlags {
	const implicit = raw[0] === undefined || raw[0].startsWith('-')
	const action = implicit ? 'status' : raw[0]
	if (!(actions as readonly string[]).includes(action))
		throw new Error(`Unknown resident action ${action}. Use: ${actions.join(', ')}.`)
	const own = new Map<string, string>()
	const forwarded: string[] = []
	let executorStopped = false
	for (let i = implicit ? 0 : 1; i < raw.length; i++) {
		const item = raw[i]
		if (item === '--') {
			forwarded.push(...raw.slice(i))
			break
		}
		if (item === '--executor-stopped') {
			if (executorStopped) throw new Error('Duplicate --executor-stopped.')
			executorStopped = true
			continue
		}
		const [name, ...suffix] = item.split('=')
		if (
			['--agent', '--max-steps', '--max-idle-ms', '--claim', '--revision', '--outcome'].includes(
				name,
			)
		) {
			if (own.has(name)) throw new Error(`Duplicate ${name}.`)
			const value = suffix.length ? suffix.join('=') : raw[++i]
			if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`)
			own.set(name, value)
		} else forwarded.push(item)
	}
	const run = parseRunFlags(forwarded)
	if (run.unknown.length) throw new Error(`Unknown option(s): ${run.unknown.join(', ')}.`)
	if (run.permissionMode && !isPermissionMode(run.permissionMode))
		throw new Error('Invalid --permission-mode; use prompt, accept-edits, auto, strict or plan.')
	if (
		run.gateRetries !== null &&
		(!run.gates.length || !Number.isSafeInteger(run.gateRetries) || run.gateRetries < 1)
	)
		throw new Error('--gate-retries requires --gate and a whole number above zero.')
	for (const [flag, value] of [
		['--max-iterations', run.maxIterations],
		['--token-budget', run.tokenBudget],
	] as const)
		if (value !== null && !Number.isSafeInteger(value))
			throw new Error(`${flag} exceeds the supported integer range.`)
	const agent = own.get('--agent') ?? 'default'
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agent))
		throw new Error(
			'--agent requires a lowercase name of 1–64 letters, digits, underscores or hyphens.',
		)
	const rawSteps = own.get('--max-steps')
	const rawIdle = own.get('--max-idle-ms')
	const rawRevision = own.get('--revision')
	const maxSteps = rawSteps !== undefined ? integer(rawSteps, '--max-steps') : null
	const maxIdleMs = rawIdle !== undefined ? integer(rawIdle, '--max-idle-ms', true) : 60_000
	if (maxIdleMs > 2_147_483_647) throw new Error('--max-idle-ms exceeds the supported timer range.')
	const revision = rawRevision !== undefined ? integer(rawRevision, '--revision') : null
	const claim = own.get('--claim') ?? null
	const outcome = own.get('--outcome') ?? null
	if (outcome !== null && !['wait', 'complete', 'blocked'].includes(outcome))
		throw new Error('--outcome must be wait, complete or blocked.')
	if (run.session || run.resume || run.continueLast || run.waitForProviderMs !== null)
		throw new Error('Resident work cannot use conversation resume or provider-retry flags.')
	if (action !== 'run' && (maxSteps !== null || own.has('--max-idle-ms')))
		throw new Error('--max-steps and --max-idle-ms apply to resident run.')
	if (
		action !== 'run' &&
		(run.provider ||
			run.model ||
			run.effort ||
			run.permissionMode ||
			run.skipPermissions ||
			run.skills.length ||
			run.gates.length ||
			run.gateRetries !== null ||
			run.maxIterations !== null ||
			run.tokenBudget !== null)
	)
		throw new Error(
			'Provider, tool and budget options apply to resident run; add does not save execution permissions.',
		)
	if (action !== 'reconcile' && (claim || revision !== null || outcome || executorStopped))
		throw new Error('Claim, revision, outcome and executor confirmation apply to reconcile.')
	if (action === 'run' && maxSteps === null)
		throw new Error('resident run requires --max-steps <n>.')
	if (['status', 'run', 'pause', 'resume'].includes(action) && run.rest.length)
		throw new Error(`resident ${action} does not take a prompt or pursuit ID.`)
	if (action === 'add' && !run.rest.join(' ').trim())
		throw new Error('resident add requires an objective.')
	if (action === 'wake' && run.rest.length < 2)
		throw new Error('resident wake requires a pursuit ID and new evidence.')
	if (action === 'archive' && run.rest.length !== 1)
		throw new Error('resident archive requires one pursuit ID.')
	if (
		action === 'reconcile' &&
		(run.rest.length < 2 || !claim || revision === null || !outcome || !executorStopped)
	)
		throw new Error(
			'reconcile requires <pursuit-id> <inspection-summary>, --claim, --revision, --outcome and --executor-stopped. Stop all prior executors and inspect effects first.',
		)
	return {
		action: action as ResidentAction,
		agent,
		maxSteps,
		maxIdleMs,
		claim,
		revision,
		outcome: outcome as ResidentFlags['outcome'],
		executorStopped,
		run,
	}
}
