import { AUTO_CONTINUATION_USER_MESSAGE } from '../../constants/continuation.js'
import { EMPTY_TOKEN_USAGE } from '../../constants/limits.js'
import { NAMZU } from '../../constants/telemetry/index.js'
import { resolveModelPricing } from '../../pricing/index.js'
import { DiskCheckpointStore } from '../../store/run/checkpoint-disk.js'
import { RunDiskStore } from '../../store/run/disk.js'
import { getActiveSpanContext } from '../../telemetry/runtime-accessors.js'
import { type CostInfo, type TokenUsage, accumulateTokenUsage } from '../../types/common/index.js'
import type { RunId, SessionId, TenantId } from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import type { ProviderErrorInfo } from '../../types/provider/index.js'
import type { AuditEvent, AuditEventInput } from '../../types/run/audit.js'
import type { CheckpointRunScope, CheckpointStore } from '../../types/run/checkpoint-store.js'
import type { EmergencySaveData } from '../../types/run/emergency.js'
import type { Run, RunPersistenceConfig, StepResult, StopReason } from '../../types/run/index.js'
import type { RunStore } from '../../types/run/store.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import {
	type ModelPricing,
	ZERO_COST,
	accumulateCost,
	accumulateUnpricedCost,
} from '../../utils/cost.js'
import { generateAuditEventId, generateEmergencySaveId } from '../../utils/id.js'
import type { Logger } from '../../utils/logger.js'

/**
 * The pair a rate lookup needs: which driver, running which model.
 *
 * `model` may be absent because a driver can be pointed at whatever the host
 * configured and some report nothing back. Absent resolves to no rate, which
 * is the honest answer, EXCEPT for a driver that bills nothing whatever it
 * runs — see `resolveModelPricing`.
 */
export interface PricingSubject {
	readonly providerId: string
	readonly model: string | undefined
}

export class RunPersistence {
	private run: Run
	private runStore: RunStore
	private checkpointStore: CheckpointStore
	private pricing?: ModelPricing

	/** See {@link recordTurnUsage}. */
	private _lastPromptTokens?: number
	/** See {@link lastPromptMessageCount}. */
	private _lastPromptMessageCount?: number
	private log: Logger
	private readonly _sessionId: SessionId
	private readonly _topicId: TopicId
	private readonly _tenantId: TenantId
	private readonly _projectId: ProjectId

	constructor(config: RunPersistenceConfig) {
		this.pricing = config.pricing
		this.log = config.log
		this._sessionId = config.sessionId
		this._topicId = config.topicId
		this._tenantId = config.tenantId
		this._projectId = config.projectId

		// The run's own evidence goes through the same kind of injectable seam
		// the checkpoint store already had. Without it the transcript, the run
		// record and the report could only ever live on a local filesystem —
		// which for a kernel whose purpose is auditable evidence made the
		// evidence the one thing that could not be pointed at durable storage.
		this.runStore =
			config.runStore ??
			new RunDiskStore({
				baseDir: config.outputDir,
				logger: config.log,
			})

		// Checkpoints go through the injectable seam; the disk layout under
		// `outputDir` (same tree the runStore writes to) stays the default.
		//
		// The attribution is handed over because the layout does not record
		// it — there is no tenant segment in the path at all — and without it
		// the default store can persist checkpoints but cannot ENUMERATE
		// them, which is the state the contract just stopped being in. A
		// listing capability the default store declines is a capability no
		// host reaches.
		this.checkpointStore =
			config.checkpointStore ??
			new DiskCheckpointStore(
				{
					baseDir: config.outputDir,
					logger: config.log,
				},
				{
					tenantId: config.tenantId,
					projectId: config.projectId,
					sessionId: config.sessionId,
				},
			)

		this.run = {
			id: config.runId,
			status: 'idle',
			metadata: {
				agentId: config.agentId,
				agentName: config.agentName,
				config: config.runConfig,
				provider: config.providerId,
			},
			messages: [],
			tokenUsage: { ...EMPTY_TOKEN_USAGE },
			costInfo: { ...ZERO_COST },
			currentIteration: 0,
			startedAt: Date.now(),
			parentRunId: config.parentRunId,
			depth: config.depth,
		}
	}

	get id(): RunId {
		return this.run.id
	}

	get sessionId(): SessionId {
		return this._sessionId
	}

	get topicId(): TopicId {
		return this._topicId
	}

	get tenantId(): TenantId {
		return this._tenantId
	}

	get projectId(): ProjectId {
		return this._projectId
	}

	get status() {
		return this.run.status
	}

	get stopReason() {
		return this.run.stopReason
	}

	get messages(): Message[] {
		return this.run.messages
	}

	get tokenUsage(): TokenUsage {
		return this.run.tokenUsage
	}

	get costInfo(): CostInfo {
		return this.run.costInfo
	}

	get currentIteration(): number {
		return this.run.currentIteration
	}

	getRun(): Readonly<Run> {
		return this.run
	}

	getSession(): Readonly<Run> {
		return this.run
	}

	getRunStore(): RunStore {
		return this.runStore
	}

	/**
	 * Checkpoint persistence for this run — the injected
	 * {@link CheckpointStore} when the host provided one, otherwise the
	 * disk default. Pair with {@link getRunScope} when constructing a
	 * `CheckpointManager`.
	 */
	getCheckpointStore(): CheckpointStore {
		return this.checkpointStore
	}

	/** Full five-layer scope key for this run's checkpoint operations. */
	getRunScope(): CheckpointRunScope {
		return {
			tenantId: this._tenantId,
			projectId: this._projectId,
			sessionId: this._sessionId,
			runId: this.run.id,
			parentRunId: this.run.parentRunId,
		}
	}

	getRunDir(): string | null {
		return this.runStore.getRunDir()
	}

	/**
	 * Highest sequence already in this run's durable event log.
	 *
	 * Seeded by {@link init} and advanced by {@link commitEventSeq}. Held here
	 * rather than on the event translator because the translator is built
	 * before `init` has run and would need a second, forgettable hop to learn
	 * the seed — where `init` is already mandatory, already awaited, and
	 * already the thing that binds the store.
	 */
	private _lastEventSeq = 0

	/** Highest sequence this run's log holds. Zero before anything is recorded. */
	get lastEventSeq(): number {
		return this._lastEventSeq
	}

	/**
	 * Own counter for the audit trail's `seq` — a SEPARATE sequence space
	 * from {@link _lastEventSeq}. See `types/run/audit.ts`'s doc on
	 * `AuditEvent.seq`: the operational RunEvent transcript and the audit
	 * trail are two logs, and forcing them to share one counter just because
	 * both happen to be monotonic would make an unrelated burst on one trail
	 * move the other's cursor.
	 *
	 * Not chain-serialized against concurrent writers the way
	 * `EventTranslator.emitEvent` serializes `RunEvent.seq` (see
	 * `runtime/query/events.ts`'s `appendChain`) — every call site that
	 * exists today awaits each `recordAudit` before the next one starts for
	 * the same run. A future call site that fires audits concurrently would
	 * need the same serialization; add it there when that call site exists,
	 * not speculatively here.
	 */
	private _lastAuditSeq = 0

	async init(): Promise<void> {
		await this.runStore.initRun(this.run.id, this.run.parentRunId)
		// A resume reuses the run id and therefore the same log, so the counter
		// has to continue that log rather than start a second sequence inside
		// it. Without this, a run recalled after a crash re-numbers from 1 and a
		// consumer holding a cursor at 40 is told, truthfully and uselessly,
		// that there is nothing above it.
		const existing = await this.runStore.readEvents()
		this._lastEventSeq = existing.at(-1)?.seq ?? 0
		// Same reasoning, for the audit trail's OWN sequence space. Safe to
		// degrade to `[]` when the bound store never implements it —
		// `recordAudit` refuses on such a store regardless (see its own doc),
		// so seeding at zero here costs nothing a later write would have used.
		const existingAudit = (await this.runStore.readAuditEvents?.()) ?? []
		this._lastAuditSeq = existingAudit.at(-1)?.seq ?? 0
		await this.runStore.writeRunMeta(this.run)
	}

	/**
	 * The number the NEXT durable event would take. Not yet taken — see
	 * {@link commitEventSeq}.
	 */
	nextEventSeq(): number {
		return this._lastEventSeq + 1
	}

	/**
	 * Take the candidate number, once its event is actually in the log.
	 *
	 * Split from {@link nextEventSeq} so a failed append consumes nothing: a
	 * `seq` is a claim that the event is recoverable, and advancing the counter
	 * before the write lands would leave a hole no event fills and hand a live
	 * consumer a cursor pointing at it.
	 */
	commitEventSeq(seq: number): void {
		if (seq > this._lastEventSeq) this._lastEventSeq = seq
	}

	markRunning(): void {
		this.run.status = 'running'
	}

	markCompleted(stopReason?: StopReason): void {
		this.run.status = 'completed'
		if (stopReason) {
			this.run.stopReason = stopReason
		}
		this.run.endedAt = Date.now()
		this.resolveResult()
	}

	markFailed(error: string, providerError?: ProviderErrorInfo): void {
		this.run.status = 'failed'
		this.run.stopReason = 'error'
		this.run.lastError = error
		if (providerError) this.run.lastProviderError = providerError
		this.run.endedAt = Date.now()
	}

	markCancelled(): void {
		this.run.status = 'cancelled'
		this.run.stopReason = 'cancelled'
		this.run.endedAt = Date.now()
	}

	setStopReason(reason: StopReason): void {
		this.run.stopReason = reason
	}

	setLastError(error: string): void {
		this.run.lastError = error
	}

	incrementIteration(): number {
		this.run.currentIteration++
		return this.run.currentIteration
	}

	pushMessage(message: Message): void {
		this.run.messages.push(message)
	}

	/**
	 * Who served the tokens being accumulated, so a rate can be found for them.
	 *
	 * Both fields are required. The previous signature took usage alone and
	 * priced it from one table the run was constructed with, which is why the
	 * only way to get a non-zero cost was for a host to pass that table — and
	 * no shipped surface did. Naming the subject at every call site is what
	 * lets the catalogue answer, and it makes a site that cannot say who served
	 * a compile error rather than a silent misattribution.
	 */
	private resolvePricing(servedBy: PricingSubject): ModelPricing | undefined {
		// A host-supplied table wins. It is a deliberate declaration about this
		// run, and `query()` already refuses to accept one alongside a provider
		// chain of more than one member, so it cannot be silently spread across
		// two rate cards here.
		if (this.pricing) return this.pricing
		return resolveModelPricing(servedBy.providerId, servedBy.model)
	}

	accumulateUsage(usage: TokenUsage, servedBy: PricingSubject): void {
		this.run.tokenUsage = accumulateTokenUsage(this.run.tokenUsage, usage)

		const pricing = this.resolvePricing(servedBy)
		// No rate is not the same as a rate of zero, and the difference is the
		// whole point of this change. Tokens nobody can price are counted as
		// such, so `costInfo.unpricedTokens` distinguishes "this cost nothing"
		// from "nobody knows what this cost" — and so the budget guard can
		// refuse rather than pass a limit it cannot measure.
		this.run.costInfo =
			pricing === undefined
				? accumulateUnpricedCost(this.run.costInfo, usage)
				: accumulateCost(this.run.costInfo, usage, pricing)
	}

	/**
	 * Accumulate usage from a MAIN-LOOP turn, and remember its prompt size.
	 *
	 * `tokenUsage.promptTokens` is cumulative across turns, so it says
	 * nothing about how full the context currently is. The last turn's
	 * prompt count does: it is the provider's own measurement of the
	 * context it just received. Compaction needs that number and nothing
	 * else gives it — a char/4 heuristic is the alternative.
	 *
	 * Side-channel calls (advisory, the compaction verifier, routing) use
	 * plain {@link accumulateUsage} instead: their prompts are not the
	 * run's context, and letting them write here would corrupt the signal.
	 */
	recordTurnUsage(usage: TokenUsage, servedBy: PricingSubject): void {
		this.accumulateUsage(usage, servedBy)
		this._lastPromptTokens = usage.promptTokens
		// How much of the history that number covers. The loop pushes the
		// assistant message and its tool results AFTER this call, so without
		// the watermark a reader cannot tell which messages the provider
		// actually weighed — and every one appended since is invisible to it.
		this._lastPromptMessageCount = this.run.messages.length
	}

	/**
	 * Forget the last prompt measurement. Called after compaction: the
	 * reading described the context that was just replaced, so leaving it
	 * in place would re-trigger compaction against a window that no longer
	 * exists.
	 */
	/**
	 * Attach the loop's per-iteration record to the run so a host that
	 * persists the returned `Run` keeps per-step attribution instead of
	 * having to reconstruct it from raw events.
	 */
	/** Record the validated structured output on the run. */
	/**
	 * Override the assembled result.
	 *
	 * Used by the output-guardrail rewrite path: the run produced text, a
	 * policy corrected it, and the corrected text is what `run_completed`
	 * and `Run.result` must carry.
	 */
	/**
	 * Override the run's final text.
	 *
	 * The override is sticky: `resolveResult` re-derives the result from the
	 * message tail, and it runs again when the run settles, so without this
	 * flag a guardrail's redaction was silently re-expanded back to the raw
	 * model output at `markCompleted`. The previous code only survived that
	 * by settling the run EARLY — which is what made configuring a guardrail
	 * rewrite a cancelled run's status.
	 */
	setResult(result: string): void {
		this.run.result = result
		this.resultOverridden = true
	}

	/**
	 * Record the schema-validated answer, and make `result` agree with it.
	 *
	 * `result` used to be left alone here, and the consequence was not "empty"
	 * but "wrong": `resolveResult` walks back from the message tail and stops at
	 * the first non-assistant message, so a structured run — whose last
	 * assistant turn is a tool call, not prose — kept whatever text an EARLIER
	 * turn happened to produce. A host reading `run.result` got a sentence from
	 * the middle of the run presented as its answer.
	 *
	 * Three options, and the other two are worse:
	 *
	 *  - leave it: a stale value read as a fact, which is the defect;
	 *  - clear it: a run that plainly answered reports no answer, so a host
	 *    testing `if (run.result)` concludes nothing was produced;
	 *  - serialize the structured value into it, which is what this does.
	 *
	 * The serialization is not an invention. Every text-shaped consumer — the
	 * transcript, `Run.result`, both delegation tools handing a child's answer
	 * back to a parent model — needs the answer as a string, and each of them
	 * would otherwise serialize it again, differently. One serialization, at the
	 * moment the value is known.
	 *
	 * Sticky, via `setResult`: `resolveResult` runs again when the run settles,
	 * and without the override flag it would walk the tail and put the stale
	 * prose back.
	 */
	setStructuredOutput(value: unknown): void {
		this.run.structuredOutput = value
		this.setResult(typeof value === 'string' ? value : JSON.stringify(value))
	}

	/**
	 * Name the delegated work this run ended without waiting for.
	 *
	 * See {@link Run.abandonedTaskIds}. Recording rather than cancelling is
	 * the point: the kernel owes the caller the truth about what it walked
	 * away from, and nothing more.
	 */
	setAbandonedTaskIds(taskIds: readonly string[]): void {
		if (taskIds.length === 0) return
		this.run.abandonedTaskIds = [...taskIds]
	}

	setSteps(steps: readonly StepResult[]): void {
		this.run.steps = steps
	}

	/**
	 * Record that a provider chain advanced, so the run record stops naming a
	 * member that did not serve.
	 *
	 * Last writer wins on purpose: a chain of four can advance three times in
	 * one run, and `metadata.servingProvider` answers "who was serving when
	 * this ended", not "who was ever asked". The full sequence is in the
	 * transcript's `provider_fallback` events and, per turn, in
	 * `steps[].servedBy`.
	 */
	setServingProvider(providerId: string): void {
		this.run.metadata.servingProvider = providerId
	}

	/**
	 * Who is serving right now, for a side-channel call that has no provenance
	 * of its own.
	 *
	 * The main loop does not use this — it reads `servedBy` off the turn, which
	 * is exact. Compaction and the closing summary go through the same wrapped
	 * provider without recording who answered, and this is the best available
	 * answer for them: the fallback decorator reports the head member's id
	 * whoever is actually serving, so asking the provider would hand back the
	 * declaration rather than the fact.
	 */
	get servingProviderId(): string {
		return this.run.metadata.servingProvider ?? this.run.metadata.provider
	}

	clearLastPromptTokens(): void {
		this._lastPromptTokens = undefined
		this._lastPromptMessageCount = undefined
	}

	/**
	 * Provider-reported size of the most recent main-loop prompt, or
	 * `undefined` before the first turn completes.
	 */
	get lastPromptTokens(): number | undefined {
		return this._lastPromptTokens
	}

	/**
	 * How many messages {@link lastPromptTokens} covers. Anything at or
	 * after this index was appended once the measurement was already taken
	 * and has to be accounted for separately.
	 */
	get lastPromptMessageCount(): number | undefined {
		return this._lastPromptMessageCount
	}

	/**
	 * Seed the spend counters from a checkpoint so a resumed run continues
	 * its budget instead of starting a fresh one.
	 *
	 * Without this, a run checkpointed at $4.80 of a $5 cap came back with a
	 * brand-new $5: a task that parked five times spent 5x its cap while
	 * every invocation truthfully reported itself in budget. The checkpoint
	 * already persisted all three values — they were written and discarded
	 * on the way back in.
	 *
	 * Restore, not accumulate: the caller holds a checkpoint's absolute
	 * totals, and adding them to a freshly-zeroed run would be the same
	 * arithmetic only by accident.
	 */
	restoreUsage(tokenUsage: TokenUsage, costInfo: CostInfo, currentIteration: number): void {
		this.run.tokenUsage = { ...tokenUsage }
		this.run.costInfo = { ...costInfo }
		this.run.currentIteration = currentIteration
	}

	/**
	 * Assemble the final assistant output WITHOUT settling the run.
	 *
	 * An output guardrail has to read what the run produced before it can
	 * judge it, and the only way to materialize that used to be
	 * `markCompleted()` — which force-marked a cancelled or paused run as
	 * `completed` merely because a guardrail was configured. Reading and
	 * settling are different operations; this is the read.
	 */
	materializeResult(): string {
		this.resolveResult()
		return this.run.result ?? ''
	}

	/** Set once a caller has explicitly supplied the final text. */
	private resultOverridden = false

	private resolveResult(): void {
		if (this.resultOverridden) return

		// Walk the tail of the message log to assemble the final
		// assistant output. The iteration loop's auto-continuation
		// path (see `runtime/query/iteration/index.ts`) inserts a
		// synthetic user prompt — exactly equal to
		// `AUTO_CONTINUATION_USER_MESSAGE` — between two assistant
		// messages whenever a turn ended with
		// `stop_reason: max_tokens` mid-text. Treat that synthetic
		// user as transparent: keep collecting assistant content past
		// it so the run's persisted `result` carries the full
		// multi-turn output, not just the trailing continuation
		// chunk. Stops at the first non-assistant, non-marker
		// message (e.g. the real user prompt that started the run,
		// or a tool message between turns).
		const chunks: string[] = []
		for (let i = this.run.messages.length - 1; i >= 0; i--) {
			const msg = this.run.messages[i]
			if (!msg) continue
			if (msg.role === 'assistant') {
				if (msg.content !== null) chunks.push(msg.content)
				continue
			}
			if (msg.role === 'user' && msg.content === AUTO_CONTINUATION_USER_MESSAGE) {
				// Synthetic continuation prompt — skip and keep
				// collecting the partial that preceded it.
				continue
			}
			break
		}

		if (chunks.length > 0) {
			// chunks were collected newest-first; reverse so the
			// assembled string is chronological.
			this.run.result = chunks.reverse().join('')
		}
	}

	toEmergencySnapshot(signal: string): EmergencySaveData {
		return {
			id: generateEmergencySaveId(),
			runId: this.run.id,
			messages: this.run.messages,
			tokenUsage: this.run.tokenUsage,
			currentIteration: this.run.currentIteration,
			startedAt: this.run.startedAt,
			savedAt: Date.now(),
			processSignal: signal,
			lastError: this.run.lastError,
		}
	}

	/**
	 * Append one entry to this run's audit trail, and — only once that write
	 * has actually landed — emit the bridge pointer to the operational log.
	 * See ses_020's logging design §5.
	 *
	 * **Durability is unconditional and the failure mode is asymmetric with
	 * logging on purpose.** `RunStore.appendAuditEvent` is OPTIONAL on the
	 * contract (a host's custom store may not implement it, same as
	 * `addToIndex`), but silently running without an audit trail is exactly
	 * the degradation `refuse-do-not-degrade` forbids — so a bound store that
	 * lacks it is a THROWN error here, not a skipped write. Because this is
	 * called from every run's terminal path (see `runtime/query/result.ts`),
	 * a store lacking it will throw on the FIRST run against it — this is a
	 * major-version compatibility break for any host with a custom RunStore,
	 * documented as such in this release's changeset. When the store DOES
	 * implement it, a rejection from `appendAuditEvent` is NOT caught: it
	 * propagates to the caller, because an audit write failing must fail the
	 * operation it was recording — unlike `createLogger`'s `dispatch`, which
	 * swallows a throwing sink and counts it. See
	 * `manager/run/__tests__/audit-durability.test.ts`, which pins both
	 * halves of that asymmetry against ONE call, including the bridge log
	 * record below going through a throwing sink.
	 */
	async recordAudit(input: AuditEventInput): Promise<AuditEvent> {
		const span = getActiveSpanContext()
		const event: AuditEvent = {
			id: generateAuditEventId(),
			runId: this.run.id,
			seq: this._lastAuditSeq + 1,
			timestamp: Date.now(),
			who: {
				agentId: this.run.metadata.agentId,
				tenantId: this._tenantId,
				...(input.persona !== undefined ? { persona: input.persona } : {}),
			},
			what: input.what,
			outcome: input.outcome,
			// The run's cumulative total AT THIS MOMENT — matching `Run.costInfo`'s
			// own semantics (see `accumulateCost`: the field IS the running total,
			// not a delta, so "last write wins" is already how the derived summary
			// treats it).
			cost: this.run.costInfo,
			...(input.reason !== undefined ? { reason: input.reason } : {}),
			...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
		}

		if (!this.runStore.appendAuditEvent) {
			throw new Error(
				"This run's RunStore does not implement appendAuditEvent. A backend that cannot " +
					'durably record the audit trail must refuse rather than run with one silently ' +
					'absent — implement RunStore.appendAuditEvent (and readAuditEvents), or bind this ' +
					'run to a store that does.',
			)
		}
		await this.runStore.appendAuditEvent(event)
		// Advanced only once the write actually landed — same discipline
		// `commitEventSeq` applies to the RunEvent stream. The append above
		// already threw before this line is reached on a failed write, so there
		// is no phantom claim on a `seq` no entry occupies.
		if (event.seq > this._lastAuditSeq) this._lastAuditSeq = event.seq

		// The bridge, one direction only (design §5): AT MOST ONE operational
		// record per audit write, carrying a POINTER — id and seq — never the
		// event's own content. Never caught: this is an ordinary logger call
		// and `createLogger`'s own dispatch already swallows a throwing sink,
		// which is the asymmetry this method exists to preserve rather than
		// reimplement.
		this.log.info('namzu.audit.written', {
			'namzu.audit.event_id': event.id,
			'namzu.audit.seq': event.seq,
		})

		return event
	}

	async persist(): Promise<void> {
		await this.runStore.writeRunMeta(this.run)
		await this.runStore.writeMessages(this.run)
		// Optional on the contract: a backend whose runs are already queryable
		// has no browsable directory to add a row to.
		await this.runStore.addToIndex?.(this.run)

		if (this.run.result) {
			await this.runStore.writeReport(this.run.result)
		}

		this.log.info('Run persisted to disk', {
			[NAMZU.RUN_ID]: this.run.id,
			'namzu.manager.dir': this.runStore.getRunDir(),
		})
	}
}
