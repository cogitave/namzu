import { join } from 'node:path'
import { isDeepStrictEqual, stripVTControlCharacters } from 'node:util'
import {
	type ResidentAdmission,
	type ResidentConsumptionOptions,
	type ResidentConsumptionReceipt,
	type ResidentConsumptionReport,
	type ResidentConsumptionResolver,
	inspectResidentConsumption,
	isEntityId,
} from '@namzu/sdk'
import type { CliResident } from './storage.js'
import { readResidentAttemptReceipt } from './tool-evidence.js'

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid resident receipt object.')
	return value as Record<string, unknown>
}
function count(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		throw new Error('Invalid receipt count.')
	return value
}
function text(value: unknown): string {
	if (typeof value !== 'string') throw new Error('Invalid receipt text.')
	return value
}
function id(value: unknown): string {
	if (!isEntityId(value, 'run')) throw new Error('Invalid receipt identity.')
	return value
}
function identity(value: unknown) {
	const v = object(value)
	if (v.version !== 1) throw new Error('Unknown attempt receipt version.')
	return {
		version: 1,
		pursuitId: id(v.pursuitId),
		claimId: id(v.claimId),
		sessionId: id(v.sessionId),
		runId: id(v.runId),
	}
}
function parseBudget(value: unknown) {
	if (value === undefined) return null
	const b = object(value)
	if (typeof b.poisoned !== 'boolean') throw new Error('Invalid budget state.')
	return {
		ownTokens: count(b.ownTokens),
		treeTokens: count(b.treeTokens),
		inFlightRequests: count(b.inFlightRequests),
		unsettledChildren: count(b.unsettledChildren),
		poisoned: b.poisoned,
		unresolvedRequests: b.unresolvedRequests === undefined ? null : count(b.unresolvedRequests),
	}
}
function parseFinish(value: unknown) {
	const f = object(value)
	if (f.cleanup !== 'confirmed' && f.cleanup !== 'unconfirmed')
		throw new Error('Unknown cleanup state.')
	if (f.error !== null) text(f.error)
	if (f.stopReason !== null) text(f.stopReason)
	const decision = f.decision === null ? null : object(f.decision)
	if (decision && !['wait', 'complete', 'blocked'].includes(text(decision.kind)))
		throw new Error('Invalid attempt outcome.')
	const u = f.usage === null ? null : object(f.usage)
	const cost = u ? object(u.cost) : null
	if (
		cost &&
		(typeof cost.totalCost !== 'number' || !Number.isFinite(cost.totalCost) || cost.totalCost < 0)
	)
		throw new Error('Invalid cost.')
	return {
		...identity(f),
		finishedAt: count(f.finishedAt),
		cleanup: f.cleanup,
		error: f.error,
		decision,
		budget: parseBudget(f.budget),
		verificationPolicy: f.verificationPolicy,
		verification: f.verification ? object(f.verification) : null,
		usage:
			u && cost
				? {
						totalTokens: count(u.totalTokens),
						cost: {
							totalCost: cost.totalCost as number,
							unpricedTokens: count(cost.unpricedTokens),
						},
					}
				: null,
	}
}

/** Uses only scoped attempt/run records. No provider discovery or session writes. */
export function residentConsumptionResolver(resident: CliResident): ResidentConsumptionResolver {
	const read = async (path: string, signal?: AbortSignal) => {
		try {
			return await readResidentAttemptReceipt(resident.root, path, signal)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
			throw error
		}
	}
	return {
		maxReadBytes: 3 * 65_536,
		async resolve(
			admission: ResidentAdmission,
			signal?: AbortSignal,
		): Promise<ResidentConsumptionReceipt | null> {
			id(admission.claimId)
			const dir = join(resident.artifactsRoot, admission.claimId)
			const rawStart = await read(join(dir, 'start.json'), signal)
			if (!rawStart) return null
			const start = { ...identity(rawStart), startedAt: count(object(rawStart).startedAt) }
			if (start.claimId !== admission.claimId || start.pursuitId !== admission.pursuitId)
				throw new Error('Attempt does not match the admitted claim.')
			const rawRun = await read(
				join(resident.root, 'sessions', start.sessionId, 'runs', start.runId, 'run.json'),
				signal,
			)
			if (!rawRun) return null
			const raw = object(rawRun)
			const run = {
				id: id(raw.id),
				metadata: { scope: object(object(raw.metadata).scope) },
				tokenUsage: { totalTokens: count(object(raw.tokenUsage).totalTokens) },
				budget: parseBudget(raw.budget),
			}
			if (
				run.id !== start.runId ||
				!isDeepStrictEqual(run.metadata.scope, {
					tenantId: resident.tenantId,
					projectId: resident.projectId,
					sessionId: start.sessionId,
					runId: start.runId,
				})
			)
				throw new Error('Attempt run is outside this resident project.')
			const rawFinish = await read(join(dir, 'finish.json'), signal)
			const finish = rawFinish === null ? null : parseFinish(rawFinish)
			if (
				finish &&
				(!isDeepStrictEqual(identity(start), identity(finish)) ||
					finish.finishedAt < start.startedAt)
			)
				throw new Error('Attempt receipts disagree.')
			if (finish?.usage && finish.usage.totalTokens !== run.tokenUsage.totalTokens)
				throw new Error('Finish usage disagrees with the scoped run.')
			const tree = finish?.budget ?? run.budget
			if (tree && tree.ownTokens !== run.tokenUsage.totalTokens)
				throw new Error('Tree ledger disagrees with own usage.')
			let verification: ResidentConsumptionReceipt['verification'] =
				!finish || finish.verificationPolicy ? 'unconfirmed' : 'unconfigured'
			if (finish?.verification) {
				const receipt = object(finish.verification.receipt)
				if (
					!/^[a-f0-9]{64}$/.test(text(finish.verification.answerSha256)) ||
					!Array.isArray(receipt.observations) ||
					receipt.observations.length < 1 ||
					receipt.observations.length > 32
				)
					throw new Error('Invalid verification receipt.')
				const expectedScope = {
					tenantId: resident.tenantId,
					projectId: resident.projectId,
					pursuitId: admission.pursuitId,
					claimId: admission.claimId,
					sessionId: start.sessionId,
					runId: start.runId,
					revision: admission.pursuitRevision,
				}
				if (
					!isDeepStrictEqual(JSON.parse(text(receipt.scope)), expectedScope) ||
					receipt.runId !== start.runId ||
					finish.decision?.kind !== 'complete' ||
					finish.error !== null ||
					finish.cleanup !== 'confirmed' ||
					receipt.observations.some((item) => {
						const o = object(item)
						const at = count(o.observedAt)
						count(o.bytes)
						text(o.source)
						return (
							!/^[a-f0-9]{64}$/.test(text(o.sha256)) ||
							at < start.startedAt ||
							at > finish.finishedAt
						)
					})
				)
					throw new Error('Verification receipt does not match this attempt.')
				const policy = object(finish.verificationPolicy)
				const claims = object(receipt.claims)
				if (
					policy.version !== 1 ||
					!Array.isArray(policy.claims) ||
					policy.claims.length < 1 ||
					policy.claims.length > 32 ||
					Object.keys(claims).length !== policy.claims.length
				)
					throw new Error('Invalid verification policy.')
				const requirements = policy.claims.map(object)
				const sources = new Set(requirements.map((r) => text(r.source)))
				if (
					new Set(requirements.map((r) => text(r.id))).size !== requirements.length ||
					requirements.some((r) => {
						const key = text(r.id)
						const value = claims[key]
						return (
							!Object.hasOwn(claims, key) ||
							!(
								value === null ||
								typeof value === 'boolean' ||
								(typeof value === 'string' && value.length <= 2000) ||
								(typeof value === 'number' && Number.isSafeInteger(value))
							) ||
							(Object.hasOwn(r, 'expected') && !isDeepStrictEqual(value, r.expected))
						)
					}) ||
					receipt.observations.length !== sources.size ||
					new Set(receipt.observations.map((o) => text(object(o).source))).size !== sources.size ||
					receipt.observations.some((o) => !sources.has(text(object(o).source)))
				)
					throw new Error('Incomplete verification evidence.')
				verification = 'recorded'
			}
			return {
				runId: start.runId,
				ownTokens: finish?.usage?.totalTokens ?? run.tokenUsage.totalTokens,
				treeTokens: tree?.treeTokens ?? null,
				ownCostUsd: finish?.usage?.cost.totalCost ?? null,
				unpricedOwnTokens: finish?.usage?.cost.unpricedTokens ?? null,
				usageFinal:
					!!finish?.usage &&
					finish.error === null &&
					finish.cleanup === 'confirmed' &&
					!!tree &&
					tree.inFlightRequests === 0 &&
					tree.unsettledChildren === 0 &&
					!tree.poisoned &&
					tree.unresolvedRequests === 0,
				cleanup: (finish?.cleanup ?? 'unknown') as ResidentConsumptionReceipt['cleanup'],
				verification,
			}
		},
	}
}

const line = (value: string) => stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ')

export function residentInspectionText(report: ResidentConsumptionReport): string {
	const { recorded, unknown } = report
	const deferred = report.attempts.filter((a) => a.receiptStatus === 'deferred')
	const missing = report.attempts.filter((a) => a.receiptStatus === 'missing').length
	const invalid = report.attempts.filter(
		(a) => a.receiptStatus === 'invalid' || a.receiptStatus === 'duplicate-run',
	).length
	const settled = report.attempts.filter((a) => a.settlement).length
	const verified = report.attempts.filter(
		(a) => a.settlement?.outcome === 'complete' && a.receipt?.verification === 'recorded',
	).length
	return [
		`Resident ${line(report.scope.agentKey)} · ${report.historyComplete ? 'lifetime history' : 'partial history'}`,
		`Revisions ${report.fromRevision}–${report.throughRevision} of ${report.scope.throughRevision}${report.nextCursor === null ? '' : ` · next cursor ${report.nextCursor}`}`,
		`${report.attempts.length} admitted · ${settled} settled · ${verified} ${verified === 1 ? 'completion' : 'completions'} with recorded verification · ${report.archivedPursuits.length} archived pursuits`,
		`Recorded tokens: ${recorded.ownTokens} own · ${recorded.treeTokens} including descendants (separate totals)`,
		`Known own cost: $${recorded.ownCostUsd.toFixed(6)}${unknown.ownPriceAttempts ? ' (partial)' : ''} · ${recorded.unpricedOwnTokens} unpriced own tokens · descendant prices not included`,
		`Incomplete attempts: ${unknown.ownUsageAttempts} own usage · ${unknown.treeUsageAttempts} tree usage · ${unknown.ownPriceAttempts} own price`,
		...(report.unavailableRevisions.length
			? [`Unavailable history revisions: ${report.unavailableRevisions.join(', ')}`]
			: []),
		...(missing || invalid || deferred.length
			? [
					`Receipts: ${missing} missing · ${invalid} invalid · ${deferred.length} deferred by read allowance`,
				]
			: []),
		...(deferred[0]
			? [
					`Continue deferred receipts: resident inspect --cursor ${deferred[0].revision} --through-revision ${report.scope.throughRevision}`,
				]
			: []),
		'Accounting only; existing limits apply per step. Verification is historical, not a current-source check.',
		'',
		...report.attempts.slice(-20).map((a) => {
			const state =
				a.settlement?.outcome ??
				(report.historyComplete ? 'unsettled' : 'settlement outside this view or unresolved')
			return `${a.claimId} · step ${a.step} · ${state} · ${a.receipt?.ownTokens ?? '?'} own tokens${a.receipt?.usageFinal ? '' : ' (partial/unknown)'}\n  ${line(a.objective).slice(0, 180)}`
		}),
		...(report.attempts.length > 20
			? [`Showing latest 20 of ${report.attempts.length} inspected attempts; JSON includes all.`]
			: []),
	].join('\n')
}

export async function inspectCliResident(
	resident: CliResident,
	throughRevision: number,
	options?: ResidentConsumptionOptions,
	signal?: AbortSignal,
) {
	const inspection = await inspectResidentConsumption(
		resident.agenda.activity(throughRevision),
		residentConsumptionResolver(resident),
		options,
		signal,
	)
	return { inspection, text: residentInspectionText(inspection) }
}
