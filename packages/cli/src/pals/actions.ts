/** Trusted host actions over actual parked Pal journals. No renderer or model authority. */
import { createHash } from 'node:crypto'
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
	DiskSessionCheckpointStore,
	DiskSessionLog,
	type PalDefinition,
	type ProjectId,
	type RecordPointer,
	RecordPointerSchema,
	type SessionId,
	type SessionPaths,
	type TenantId,
	asCheckpointId,
	asTurnId,
} from '@namzu/sdk'
import { restrictToOwner } from '../integrations/providers/credential-store.js'
import { sessionLogCheckpointView } from '../integrations/sessions/checkpoint-view.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { type PermissionMode, isPermissionMode } from '../permissions/mode.js'
import type { AgentSession } from '../tui/agent.js'
import { palConversationBinding } from './conversations.js'
import { type PalWaitingReview, readPalWaitingReview } from './review.js'

/** Must be constructed by the authenticated host, never accepted from action payload JSON. */
export interface PalReviewActor {
	readonly tenantId: TenantId
	readonly actorId: string
	readonly connectionId: string
}
export interface PalReviewActionRef {
	readonly sessionId: SessionId
	readonly turnId: string
	readonly checkpointId: string
	readonly decisionId: string
	readonly requestKind: 'tool_review'
	readonly requestRecord: RecordPointer
	readonly checkpointDocSha256: string
}
export type PalReviewAnswer =
	| { readonly action: 'approve_once' }
	| { readonly action: 'reject'; readonly feedback: string }
export interface PalReviewAction {
	readonly actor: PalReviewActor
	/** Stable identity of the verified upstream action; not a generated retry UUID. */
	readonly operationId: string
	readonly waiting: PalReviewActionRef
	readonly answer: PalReviewAnswer
}
export interface PalReviewActionReceipt {
	readonly status: 'resolved'
	readonly operationId: string
	readonly decisionId: string
	readonly requestRecord: RecordPointer
	readonly resolutionRecord: RecordPointer
}
export interface CliPalReviewActions {
	execute(action: PalReviewAction, signal?: AbortSignal): Promise<PalReviewActionReceipt>
}
export interface CliPalReviewActionsOptions {
	readonly profile: PalDefinition
	readonly scope: {
		readonly tenantId: TenantId
		readonly projectId: ProjectId
		readonly sessionId: SessionId
	}
	readonly paths: SessionPaths
	readonly session: Pick<AgentSession, 'resumePaused'>
	/** Trusted live host policy; never read from the channel action payload. */
	readonly currentPermissionMode: () => PermissionMode
	/** Current authority to decide this exact request; separate from viewing it or its activity. */
	readonly authorize: (
		actor: PalReviewActor,
		ref: PalReviewActionRef,
		signal: AbortSignal,
	) => Promise<void>
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function bounded(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\0'))
		throw new Error(`Invalid Pal review ${label}.`)
}
function exactKeys(value: object, keys: readonly string[]) {
	if (Object.keys(value).some((key) => !keys.includes(key)))
		throw new Error('Unexpected Pal review action field.')
}
function snapshot(input: PalReviewAction): PalReviewAction {
	const value = structuredClone(input)
	exactKeys(value, ['actor', 'operationId', 'waiting', 'answer'])
	if (!value.actor || !value.waiting || !value.answer) throw new Error('Invalid Pal review action.')
	exactKeys(value.actor, ['tenantId', 'actorId', 'connectionId'])
	bounded(value.actor.actorId, 'actor')
	bounded(value.actor.connectionId, 'connection')
	bounded(value.operationId, 'operation identity')
	exactKeys(value.waiting, [
		'sessionId',
		'turnId',
		'checkpointId',
		'decisionId',
		'requestKind',
		'requestRecord',
		'checkpointDocSha256',
	])
	asTurnId(value.waiting.turnId)
	asCheckpointId(value.waiting.checkpointId)
	bounded(value.waiting.decisionId, 'decision identity')
	if (
		value.waiting.requestKind !== 'tool_review' ||
		!/^[a-f0-9]{64}$/.test(value.waiting.checkpointDocSha256)
	)
		throw new Error('Unsupported or invalid Pal review request.')
	RecordPointerSchema.parse(value.waiting.requestRecord)
	if (value.answer.action === 'approve_once') exactKeys(value.answer, ['action'])
	else if (value.answer.action === 'reject') {
		exactKeys(value.answer, ['action', 'feedback'])
		if (typeof value.answer.feedback !== 'string' || value.answer.feedback.length > 4096)
			throw new Error('Invalid Pal review rejection feedback.')
	} else throw new Error('Unsupported Pal review answer.')
	Object.freeze(value.actor)
	Object.freeze(value.waiting.requestRecord)
	Object.freeze(value.waiting)
	Object.freeze(value.answer)
	return Object.freeze(value)
}
function samePointer(a: RecordPointer, b: RecordPointer) {
	return a.seq === b.seq && a.offset === b.offset && a.length === b.length && a.sha256 === b.sha256
}
function directory(path: string): string {
	mkdirSync(path, { recursive: true, mode: 0o700 })
	if (
		!lstatSync(path).isDirectory() ||
		lstatSync(path).isSymbolicLink() ||
		realpathSync(path) !== path
	)
		throw new Error('Pal review action storage must have no aliases.')
	restrictToOwner(path)
	return path
}
/** A partial write is an unknown reservation, never permission to execute again. */
function reserve(file: string, value: object): boolean {
	let fd: number
	try {
		fd = openSync(file, 'wx', 0o600)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
		throw error
	}
	try {
		writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8')
		fsyncSync(fd)
	} finally {
		closeSync(fd)
	}
	return true
}
function readReservation(file: string): {
	operationId: string
	digest: string
} {
	const stat = lstatSync(file)
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768)
		throw new Error('Invalid Pal review reservation; reconciliation is required.')
	const value = JSON.parse(readFileSync(file, 'utf8')) as {
		operationId?: unknown
		digest?: unknown
	}
	if (typeof value.operationId !== 'string' || typeof value.digest !== 'string')
		throw new Error('Incomplete Pal review reservation; reconciliation is required.')
	return value as { operationId: string; digest: string }
}

export function createCliPalReviewActions(
	options: CliPalReviewActionsOptions,
): CliPalReviewActions {
	const profile = structuredClone(options.profile)
	const scope = Object.freeze({ ...options.scope })
	const authorizeAction = options.authorize
	const resumePaused = options.session.resumePaused.bind(options.session)
	const readPermissionMode = options.currentPermissionMode
	if (typeof readPermissionMode !== 'function')
		throw new Error('Pal review actions require the trusted host current permission mode.')
	const currentPermissionMode = () => {
		const mode = readPermissionMode()
		if (!isPermissionMode(mode)) throw new Error('Invalid trusted Pal review permission mode.')
		// This action grants one exact batch. A current automatic mode is not
		// a grant for later reviewed calls; independent explicit rules remain.
		return mode === 'auto' || mode === 'accept-edits' ? 'prompt' : mode
	}
	const log = DiskSessionLog.at(options.paths, { sessionId: scope.sessionId })
	const checkpoints = new DiskSessionCheckpointStore({
		paths: options.paths,
		log: sessionLogCheckpointView(log),
	})
	const root = join(resolveNamzuHome(), 'pal-review-actions')
	const assertOwner = async () => {
		const owner = await palConversationBinding(profile.workspace, scope.sessionId)
		if (
			!owner ||
			owner.definition.id !== profile.id ||
			owner.definition.revision !== profile.revision ||
			owner.pal.paused
		)
			throw new Error('This Pal review is foreign, repinned or currently paused.')
		for await (const { record } of log.read({
			mode: 'strict',
			throughSeq: 1,
		})) {
			if (
				record.type !== 'session_started' ||
				record.tenantId !== scope.tenantId ||
				record.projectId !== scope.projectId
			)
				throw new Error('This Pal review belongs to another tenant or project.')
		}
	}
	const proof = async (action: PalReviewAction): Promise<PalReviewActionReceipt | null> => {
		let requested = false
		for await (const { record, pointer } of log.read({ mode: 'strict' })) {
			if (record.turnId !== action.waiting.turnId) continue
			if (record.type === 'decision_requested' && record.decisionId === action.waiting.decisionId)
				requested =
					samePointer(pointer, action.waiting.requestRecord) &&
					record.checkpointId === action.waiting.checkpointId
			if (
				record.type !== 'decision_resolved' ||
				record.decisionId !== action.waiting.decisionId ||
				!requested
			)
				continue
			const expected =
				action.answer.action === 'approve_once'
					? { action: 'approve_tools' }
					: { action: 'reject_tools', feedback: action.answer.feedback }
			if (JSON.stringify(record.decision) !== JSON.stringify(expected))
				throw new Error('This Pal review was resolved by another decision.')
			return {
				status: 'resolved',
				operationId: action.operationId,
				decisionId: action.waiting.decisionId,
				requestRecord: { ...action.waiting.requestRecord },
				resolutionRecord: { ...pointer },
			}
		}
		return null
	}
	return {
		async execute(
			input: PalReviewAction,
			signal = new AbortController().signal,
		): Promise<PalReviewActionReceipt> {
			const action = snapshot(input)
			if (action.actor.tenantId !== scope.tenantId || action.waiting.sessionId !== scope.sessionId)
				throw new Error('Foreign Pal review actor or conversation.')
			const authorize = async () => {
				signal.throwIfAborted()
				currentPermissionMode()
				await authorizeAction(action.actor, action.waiting, signal)
				signal.throwIfAborted()
				await assertOwner()
			}
			await authorize()
			const assertExecutionAllowed = async () => {
				await authorize()
				// The native writer is acquired before the last check at tool entry.
				// After application, only its exact original resolution permits inference.
				if (await proof(action)) return
				assertExactWaiting(
					await readPalWaitingReview(log, action.waiting.turnId, action.waiting.checkpointId),
					action.waiting,
				)
			}
			// Canonical host snapshot, including its actor and exact requested bytes.
			const digest = hash(
				JSON.stringify([
					action.actor.tenantId,
					action.actor.actorId,
					action.actor.connectionId,
					action.operationId,
					action.waiting.sessionId,
					action.waiting.turnId,
					action.waiting.checkpointId,
					action.waiting.decisionId,
					action.waiting.requestKind,
					action.waiting.requestRecord.seq,
					action.waiting.requestRecord.offset,
					action.waiting.requestRecord.length,
					action.waiting.requestRecord.sha256,
					action.waiting.checkpointDocSha256,
					action.answer.action,
					action.answer.action === 'reject' ? action.answer.feedback : null,
				]),
			)
			const operationKey = hash(
				JSON.stringify([scope.tenantId, action.actor.connectionId, action.operationId]),
			)
			const decisionKey = hash(
				JSON.stringify([scope.tenantId, profile.id, scope.sessionId, action.waiting.decisionId]),
			)
			const operations = directory(join(directory(root), 'operations'))
			const decisions = directory(join(root, 'decisions'))
			const operationFile = join(operations, `${operationKey}.json`)
			const decisionFile = join(decisions, `${decisionKey}.json`)
			const reservation = {
				v: 1,
				operationId: action.operationId,
				digest,
				action,
			}
			// Read-only refusal before durable reservation or any paid/guest operation.
			let existing: { operationId: string; digest: string } | undefined
			try {
				existing = readReservation(operationFile)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
			}
			if (!existing) {
				const waiting = await readPalWaitingReview(
					log,
					action.waiting.turnId,
					action.waiting.checkpointId,
				)
				assertExactWaiting(waiting, action.waiting)
				if (
					!(await checkpoints.restore(
						{ ...scope, turnId: asTurnId(action.waiting.turnId) },
						asCheckpointId(action.waiting.checkpointId),
					))
				)
					throw new Error('This Pal decision has no restorable checkpoint.')
				await authorize()
				if (!reserve(operationFile, reservation)) existing = readReservation(operationFile)
			}
			if (existing) {
				if (existing.operationId !== action.operationId || existing.digest !== digest)
					throw new Error('Conflicting retry of a Pal review action.')
				let claimed: { operationId: string; digest: string }
				try {
					claimed = readReservation(decisionFile)
				} catch (error) {
					throw new Error(
						'This Pal action has an unconfirmed reservation; reconciliation is required.',
						{ cause: error },
					)
				}
				if (claimed.operationId !== action.operationId || claimed.digest !== digest)
					throw new Error('This Pal decision belongs to another reserved action.')
				const receipt = await proof(action)
				if (receipt) {
					await authorize()
					return receipt
				}
				throw new Error(
					'This Pal action is reserved with an unconfirmed outcome; reconciliation is required.',
				)
			}
			if (!reserve(decisionFile, reservation))
				throw new Error(
					'This Pal decision already has a reserved action; reconciliation is required.',
				)
			// Recheck the exact park after winning its permanent reservation.
			assertExactWaiting(
				await readPalWaitingReview(log, action.waiting.turnId, action.waiting.checkpointId),
				action.waiting,
			)
			await authorize()
			for await (const _event of resumePaused({
				turnId: action.waiting.turnId,
				checkpointId: action.waiting.checkpointId,
				pendingDecision:
					action.answer.action === 'approve_once'
						? { action: 'approve_tools' }
						: { action: 'reject_tools', feedback: action.answer.feedback },
				permissionMode: 'prompt',
				currentPermissionMode,
				reviewHold: {
					reason: 'A later Pal tool batch needs its own approval.',
				},
				assertExecutionAllowed,
				signal,
			})) {
			}
			const receipt = await proof(action)
			if (!receipt)
				throw new Error(
					'Pal action has no recorded decision resolution; reconciliation is required.',
				)
			await authorize()
			return receipt
		},
	}
}

function assertExactWaiting(
	waiting: PalWaitingReview | null,
	ref: PalReviewActionRef,
): asserts waiting is PalWaitingReview {
	if (
		!waiting ||
		waiting.turnId !== ref.turnId ||
		waiting.checkpointId !== ref.checkpointId ||
		waiting.decisionId !== ref.decisionId ||
		waiting.request.type !== ref.requestKind ||
		waiting.checkpointDocSha256 !== ref.checkpointDocSha256 ||
		!samePointer(waiting.requestRecord, ref.requestRecord)
	)
		throw new Error('This Pal action does not match its actual waiting decision.')
}
