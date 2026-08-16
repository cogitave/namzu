import { describe, expect, it } from 'vitest'

import {
	AuthorizationGate,
	type AuthorizationGateConfig,
	type AuthorizationRule,
	BaseRegistry,
	type ClaimFence,
	type ClaimSummary,
	ContextCache,
	type ContextCacheConfig,
	type FencingToken,
	type LeaseSummary,
	LocalTaskGateway,
	LocalTaskScheduler,
	PromptCache,
	type PromptCacheConfig,
	Registry,
	type RunClaim,
	type RunLease,
	type TaskGateway,
	type TaskScheduler,
	VerificationGate,
	type VerificationGateConfig,
	type VerificationRule,
	collect,
	collectChatCompletion,
} from '../index.js'

/**
 * The deprecation window, asserted from where a consumer stands.
 *
 * A rename ships the new name plus the old one marked `@deprecated`, and the
 * old one has to keep WORKING for the whole window — not merely keep
 * existing. Both halves of that are easy to break silently: drop the alias
 * and only an external consumer finds out; point it at the wrong thing and
 * it still imports.
 *
 * Imported from `'../index.js'` rather than from the modules that declare
 * them, because the barrel is the surface. An alias that exists but never
 * reaches the barrel is unreachable for everyone it was written for.
 *
 * Two kinds of assertion here, and they catch different failures. The
 * `toBe` checks catch a value alias that went missing or came to point
 * somewhere else. They CANNOT catch a missing type alias — a type erases,
 * so a deleted one leaves no runtime trace at all and every `toBe` below
 * would still pass. The declarations in the last case are the check for
 * those: they fail under `tsc`, which is where an erased assertion has to
 * live.
 */

describe('the renamed exports keep their old spellings for one window', () => {
	it('resolves each deprecated value alias to the symbol that replaced it', () => {
		// Identity, not `toBeDefined`. An alias pointing at some other export
		// is defined, importable, and wrong.
		expect(collect).toBe(collectChatCompletion)
		expect(Registry).toBe(BaseRegistry)
		expect(ContextCache).toBe(PromptCache)
		expect(LocalTaskGateway).toBe(LocalTaskScheduler)
		expect(VerificationGate).toBe(AuthorizationGate)
	})

	it('keeps the old spellings usable, not merely present', () => {
		// Constructing through the alias is the claim a consumer depends on:
		// their existing `new Registry()` compiles AND runs for the window.
		const r = new Registry<string>()
		r.register('a', 'x')

		expect(r.get('a')).toBe('x')
		expect(r instanceof BaseRegistry).toBe(true)
	})

	it('keeps the type aliases assignable in both directions', () => {
		// Erased at runtime — the assertion is that this FILE compiles.
		// Deleting either type alias fails `pnpm --filter @namzu/sdk
		// typecheck`, and no runtime check above would notice.
		const _r: Registry<string> = new BaseRegistry<string>()
		const _c: ContextCacheConfig = {} as PromptCacheConfig
		const _p: PromptCacheConfig = {} as ContextCacheConfig
		const _cache: ContextCache = {} as PromptCache

		// The lease trio (NZ-SURF-06). Types only — there is no runtime value
		// to compare, which is exactly why these three need a compiled
		// assertion and cannot ride on the `toBe` checks above.
		const _lease: RunClaim = {} as RunLease
		const _fence: ClaimFence = 0 as FencingToken
		const _summary: ClaimSummary = {} as LeaseSummary

		// The authorization trio (NZ-SURF-08).
		const _rule: VerificationRule = { type: 'allow_read_only' } satisfies AuthorizationRule
		const _gate: VerificationGateConfig = {} as AuthorizationGateConfig

		expect([_r, _c, _p, _cache, _lease, _fence, _summary, _rule, _gate]).toHaveLength(9)
	})

	it('still compiles an outside implementor written against the old interface', () => {
		// An `implements` clause, not a type assignment, and the difference
		// is the whole point. `const x: TaskGateway = y` proves the alias
		// resolves; it does not prove the interface is still SATISFIABLE from
		// the outside. The CLI's own subagent runtime implements this, and so
		// does every host that wrote one — a window that type-checks
		// assignments but breaks `implements` is not a window.
		class Host implements TaskGateway {
			async createTask() {
				return {} as never
			}
			async waitForTask() {
				return {} as never
			}
			async continueTask() {}
			cancelTask() {}
			getTask() {
				return undefined
			}
			listTasks() {
				return []
			}
			onTaskCompleted() {
				return () => {}
			}
		}

		// And the new name accepts it, so the two are one interface rather
		// than two that happen to look alike.
		const asNew: TaskScheduler = new Host()

		expect(asNew.listTasks()).toEqual([])
	})
})
