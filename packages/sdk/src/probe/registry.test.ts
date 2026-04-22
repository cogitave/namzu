/**
 * Ratified §9 of docs.local/sessions/ses_007-probe-and-doctor/design.md.
 * These tests pin the contract documented there — not an internal
 * implementation detail. If the semantics change, update §9 first.
 */

import { describe, expect, it, vi } from 'vitest'

import type { Logger } from '../utils/logger.js'

import { buildProbeContext } from './context.js'
import { ProbeNameCollisionError } from './errors.js'
import { createProbeRegistry } from './registry.js'

function makeLogger(): Logger {
	const self = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		child: vi.fn(),
	} as unknown as Logger
	;(self as { child: (ctx: unknown) => Logger }).child = vi.fn(() => self)
	return self
}

describe('ProbeRegistry — typed dispatch', () => {
	it('fires a typed probe when the event kind matches', () => {
		const reg = createProbeRegistry()
		const seen: string[] = []
		reg.on('tool_executing', (event) => {
			seen.push(event.toolName)
		})
		reg.dispatch(
			{
				type: 'tool_executing',
				runId: 'run_1' as never,
				toolName: 'fs.read',
				input: {},
			} as never,
			buildProbeContext(),
		)
		expect(seen).toEqual(['fs.read'])
	})

	it('does not fire a typed probe for a different event kind', () => {
		const reg = createProbeRegistry()
		const handler = vi.fn()
		reg.on('tool_executing', handler)
		reg.dispatch(
			{ type: 'tool_completed', runId: 'r' as never, toolName: 't', result: 'ok' } as never,
			buildProbeContext(),
		)
		expect(handler).not.toHaveBeenCalled()
	})

	it('supports array-of-kinds registration', () => {
		const reg = createProbeRegistry()
		const seen: string[] = []
		reg.on(['tool_executing', 'tool_completed'], (event) => {
			seen.push(event.type)
		})
		reg.dispatch(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 't', input: {} } as never,
			buildProbeContext(),
		)
		reg.dispatch(
			{ type: 'tool_completed', runId: 'r' as never, toolName: 't', result: 'ok' } as never,
			buildProbeContext(),
		)
		expect(seen).toEqual(['tool_executing', 'tool_completed'])
	})

	it('applies the where filter before the handler', () => {
		const reg = createProbeRegistry()
		const handler = vi.fn()
		reg.on('tool_executing', handler, {
			where: (event) => event.toolName === 'fs.write',
		})
		reg.dispatch(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 'fs.read', input: {} } as never,
			buildProbeContext(),
		)
		expect(handler).not.toHaveBeenCalled()
		reg.dispatch(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 'fs.write', input: {} } as never,
			buildProbeContext(),
		)
		expect(handler).toHaveBeenCalledTimes(1)
	})
})

describe('ProbeRegistry — ordering', () => {
	it('fires probes in ascending priority; ties break by registration order', () => {
		const reg = createProbeRegistry()
		const order: string[] = []
		reg.on('tool_executing', () => order.push('a'), { priority: 10, name: 'a' })
		reg.on('tool_executing', () => order.push('b'), { priority: 5, name: 'b' })
		reg.on('tool_executing', () => order.push('c'), { priority: 10, name: 'c' })
		reg.on('tool_executing', () => order.push('d'), { priority: 0, name: 'd' })
		reg.dispatch(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 't', input: {} } as never,
			buildProbeContext(),
		)
		expect(order).toEqual(['d', 'b', 'a', 'c'])
	})

	it('typed probes fire BEFORE the between-tier callback; catch-all fires AFTER', () => {
		const reg = createProbeRegistry()
		const order: string[] = []
		reg.on('tool_executing', () => order.push('typed'))
		reg.onAny(() => order.push('any'))
		reg.dispatch(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 't', input: {} } as never,
			buildProbeContext(),
			() => order.push('between'),
		)
		expect(order).toEqual(['typed', 'between', 'any'])
	})
})

describe('ProbeRegistry — name collision + override', () => {
	it('throws ProbeNameCollisionError on duplicate name without override', () => {
		const reg = createProbeRegistry()
		reg.on('tool_executing', () => {}, { name: 'dup' })
		expect(() => reg.on('tool_executing', () => {}, { name: 'dup' })).toThrow(
			ProbeNameCollisionError,
		)
	})

	it('allows replacing when override: true', () => {
		const reg = createProbeRegistry()
		const first = vi.fn()
		const second = vi.fn()
		reg.on('tool_executing', first, { name: 'x' })
		reg.on('tool_executing', second, { name: 'x', override: true })
		reg.dispatch(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 't', input: {} } as never,
			buildProbeContext(),
		)
		expect(first).not.toHaveBeenCalled()
		expect(second).toHaveBeenCalledTimes(1)
	})

	it('unsubscribes the previous entry on override so the name can be reused', () => {
		const reg = createProbeRegistry()
		reg.on('tool_executing', () => {}, { name: 'x' })
		reg.on('tool_executing', () => {}, { name: 'x', override: true })
		expect(() => reg.on('tool_executing', () => {}, { name: 'x' })).toThrow(ProbeNameCollisionError)
	})
})

describe('ProbeRegistry — throw isolation', () => {
	it('a throwing probe does not suppress later probes', () => {
		const reg = createProbeRegistry()
		reg.setLogger(makeLogger())
		const seen: string[] = []
		reg.on(
			'tool_executing',
			() => {
				throw new Error('boom')
			},
			{ priority: 0, name: 'bad' },
		)
		reg.on('tool_executing', () => seen.push('ran'), { priority: 10, name: 'good' })
		reg.dispatch(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 't', input: {} } as never,
			buildProbeContext(),
		)
		expect(seen).toEqual(['ran'])
	})

	it('a throwing probe does not suppress the between-tier callback or the catch-all', () => {
		const reg = createProbeRegistry()
		reg.setLogger(makeLogger())
		const order: string[] = []
		reg.on(
			'tool_executing',
			() => {
				throw new Error('boom')
			},
			{ name: 'bad' },
		)
		reg.onAny(() => order.push('any'))
		reg.dispatch(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 't', input: {} } as never,
			buildProbeContext(),
			() => order.push('between'),
		)
		expect(order).toEqual(['between', 'any'])
	})
})

describe('ProbeRegistry — frozen event boundary', () => {
	it('freezes the event before fan-out so probes cannot mutate it', () => {
		const reg = createProbeRegistry()
		reg.on('tool_executing', (event) => {
			expect(() => {
				;(event as { toolName: string }).toolName = 'mutated'
			}).toThrow()
		})
		reg.dispatch(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 't', input: {} } as never,
			buildProbeContext(),
		)
	})

	it('later probes see the original event value, not a mutation from an earlier probe', () => {
		const reg = createProbeRegistry()
		reg.setLogger(makeLogger())
		const tampered: string[] = []
		reg.on(
			'tool_executing',
			(event) => {
				try {
					;(event as { toolName: string }).toolName = 'mutated'
				} catch {
					// expected — frozen
				}
			},
			{ priority: 0 },
		)
		reg.on(
			'tool_executing',
			(event) => {
				tampered.push(event.toolName)
			},
			{ priority: 10 },
		)
		reg.dispatch(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 'original', input: {} } as never,
			buildProbeContext(),
		)
		expect(tampered).toEqual(['original'])
	})
})

describe('ProbeRegistry — unsubscribe', () => {
	it('unsub removes the probe from subsequent dispatches', () => {
		const reg = createProbeRegistry()
		const handler = vi.fn()
		const unsub = reg.on('tool_executing', handler)
		reg.dispatch(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 't', input: {} } as never,
			buildProbeContext(),
		)
		unsub()
		reg.dispatch(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 't', input: {} } as never,
			buildProbeContext(),
		)
		expect(handler).toHaveBeenCalledTimes(1)
	})

	it('unsub on an array-kind probe removes it from every kind it was registered for', () => {
		const reg = createProbeRegistry()
		const handler = vi.fn()
		const unsub = reg.on(['tool_executing', 'tool_completed'], handler)
		unsub()
		reg.dispatch(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 't', input: {} } as never,
			buildProbeContext(),
		)
		reg.dispatch(
			{ type: 'tool_completed', runId: 'r' as never, toolName: 't', result: 'ok' } as never,
			buildProbeContext(),
		)
		expect(handler).not.toHaveBeenCalled()
	})
})

describe('ProbeRegistry — catch-all', () => {
	it('onAny receives every event regardless of kind', () => {
		const reg = createProbeRegistry()
		const seen: string[] = []
		reg.onAny((event) => seen.push(event.type))
		reg.dispatch(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 't', input: {} } as never,
			buildProbeContext(),
		)
		reg.dispatch(
			{ type: 'lock_acquired', lockId: 'lock_1' as never, filePath: '/x', owner: 'r' as never },
			buildProbeContext(),
		)
		expect(seen).toEqual(['tool_executing', 'lock_acquired'])
	})
})

describe('ProbeRegistry — ctx.isReplay', () => {
	it('defaults to false when unset', () => {
		const reg = createProbeRegistry()
		let seenReplay: boolean | undefined
		reg.on('tool_executing', (_event, ctx) => {
			seenReplay = ctx.isReplay
		})
		reg.dispatch(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 't', input: {} } as never,
			buildProbeContext(),
		)
		expect(seenReplay).toBe(false)
	})

	it('carries isReplay:true when the event is from a replayed run', () => {
		const reg = createProbeRegistry()
		let seenReplay: boolean | undefined
		reg.on('tool_executing', (_event, ctx) => {
			seenReplay = ctx.isReplay
		})
		reg.dispatch(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 't', input: {} } as never,
			buildProbeContext({ isReplay: true }),
		)
		expect(seenReplay).toBe(true)
	})
})

describe('ProbeRegistry — veto API', () => {
	it('returns allow when no veto handlers registered', () => {
		const reg = createProbeRegistry()
		const outcome = reg.queryVeto(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 't', input: {} } as never,
			buildProbeContext(),
		)
		expect(outcome.action).toBe('allow')
		expect(outcome.probeName).toBeUndefined()
	})

	it('returns deny when a veto handler returns "deny"', () => {
		const reg = createProbeRegistry()
		reg.veto('tool_executing', () => 'deny', { name: 'fs-guard' })
		const outcome = reg.queryVeto(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 'fs.write', input: {} } as never,
			buildProbeContext(),
		)
		expect(outcome.action).toBe('deny')
		expect(outcome.probeName).toBe('fs-guard')
	})

	it('returns deny + reason when handler returns { action: "deny", reason }', () => {
		const reg = createProbeRegistry()
		reg.veto('tool_executing', () => ({ action: 'deny', reason: 'outside workspace' }), {
			name: 'sandbox',
		})
		const outcome = reg.queryVeto(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 'fs.write', input: {} } as never,
			buildProbeContext(),
		)
		expect(outcome.action).toBe('deny')
		expect(outcome.probeName).toBe('sandbox')
		expect(outcome.reason).toBe('outside workspace')
	})

	it('first-deny-wins by ascending priority; subsequent veto handlers still run for audit', () => {
		const reg = createProbeRegistry()
		const audit: string[] = []
		reg.veto(
			'tool_executing',
			() => {
				audit.push('high-priority-allow')
				return 'allow'
			},
			{ priority: 0, name: 'p0-allow' },
		)
		reg.veto(
			'tool_executing',
			() => {
				audit.push('mid-priority-deny')
				return { action: 'deny', reason: 'first' }
			},
			{ priority: 5, name: 'p5-deny' },
		)
		reg.veto(
			'tool_executing',
			() => {
				audit.push('low-priority-deny')
				return { action: 'deny', reason: 'second' }
			},
			{ priority: 10, name: 'p10-deny' },
		)

		const outcome = reg.queryVeto(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 't', input: {} } as never,
			buildProbeContext(),
		)
		expect(outcome.action).toBe('deny')
		expect(outcome.probeName).toBe('p5-deny')
		expect(outcome.reason).toBe('first')
		expect(audit).toEqual(['high-priority-allow', 'mid-priority-deny', 'low-priority-deny'])
	})

	it('a throwing veto handler defaults to allow for that probe; aggregate unaffected', () => {
		const reg = createProbeRegistry()
		reg.setLogger(makeLogger())
		const audit: string[] = []
		reg.veto(
			'tool_executing',
			() => {
				audit.push('throw')
				throw new Error('boom')
			},
			{ priority: 0, name: 'bad' },
		)
		reg.veto(
			'tool_executing',
			() => {
				audit.push('allow')
				return 'allow'
			},
			{ priority: 5, name: 'good' },
		)

		const outcome = reg.queryVeto(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 't', input: {} } as never,
			buildProbeContext(),
		)
		expect(outcome.action).toBe('allow')
		expect(audit).toEqual(['throw', 'allow'])
	})

	it('observe-tier dispatch is independent — veto registration does not fire on dispatch', () => {
		const reg = createProbeRegistry()
		const vetoCalls: number[] = []
		reg.veto(
			'tool_executing',
			() => {
				vetoCalls.push(1)
				return 'deny'
			},
			{ name: 'v' },
		)
		reg.dispatch(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 't', input: {} } as never,
			buildProbeContext(),
		)
		expect(vetoCalls).toEqual([])
	})

	it('honors where filter on veto registrations', () => {
		const reg = createProbeRegistry()
		reg.veto('tool_executing', () => 'deny', {
			name: 'writes-only',
			where: (event) => event.toolName.startsWith('fs.write'),
		})

		const allow = reg.queryVeto(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 'fs.read', input: {} } as never,
			buildProbeContext(),
		)
		const deny = reg.queryVeto(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 'fs.write.x', input: {} } as never,
			buildProbeContext(),
		)
		expect(allow.action).toBe('allow')
		expect(deny.action).toBe('deny')
	})

	it('unsubscribing a veto handler removes it from subsequent queries', () => {
		const reg = createProbeRegistry()
		const unsub = reg.veto('tool_executing', () => 'deny', { name: 'g' })
		const denied = reg.queryVeto(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 't', input: {} } as never,
			buildProbeContext(),
		)
		expect(denied.action).toBe('deny')
		unsub()
		const allowed = reg.queryVeto(
			{ type: 'tool_executing', runId: 'r' as never, toolName: 't', input: {} } as never,
			buildProbeContext(),
		)
		expect(allowed.action).toBe('allow')
	})

	it('name collision applies across observe + veto tiers', () => {
		const reg = createProbeRegistry()
		reg.on('tool_executing', () => {}, { name: 'shared' })
		expect(() => reg.veto('tool_executing', () => 'allow', { name: 'shared' })).toThrow(
			ProbeNameCollisionError,
		)
	})
})
