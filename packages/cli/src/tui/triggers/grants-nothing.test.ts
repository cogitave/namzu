/**
 * A trigger is shorthand for something namzu already does: it grants
 * nothing and skips no confirmation. The only effects a trigger can have are
 * request-only context, the model's highest effort for one turn, and running
 * `/skills save` after a turn. There is no kind for a permission mode, a
 * directory, a credential, the sandbox, a tool list or a limit, and this
 * pins that: a new effect kind or key fails here until someone decides it.
 */

import { describe, expect, it } from 'vitest'

import { BUILTIN_TRIGGERS, type TriggerEffect } from './registry.js'

const ALLOWED: Record<TriggerEffect['kind'], readonly string[]> = {
	'turn-context': ['kind', 'text', 'effort'],
	'turn-effort': ['kind', 'effort'],
	'after-turn': ['kind', 'command', 'text'],
}

describe('trigger effects grant nothing', () => {
	it('has only the effect kinds and keys that grant nothing', () => {
		for (const trigger of BUILTIN_TRIGGERS) {
			const allowed = ALLOWED[trigger.effect.kind]
			expect(allowed, trigger.id).toBeDefined()
			for (const key of Object.keys(trigger.effect))
				expect(allowed, `${trigger.id}.${key}`).toContain(key)
			// An effort pin is the level /hypermode pins, or the highest for max
			// effort: never a value a trigger chooses by itself.
			if (trigger.effect.kind === 'turn-context' && 'effort' in trigger.effect)
				expect(trigger.effect.effort).toBe('hypermode')
			if (trigger.effect.kind === 'turn-effort') expect(trigger.effect.effort).toBe('highest')
			if (trigger.effect.kind === 'after-turn') expect(trigger.effect.command).toBe('/skills save')
		}
	})

	it('runs no command but /skills save, standalone or after a turn', () => {
		for (const trigger of BUILTIN_TRIGGERS) {
			if (trigger.standalone !== undefined) expect(trigger.standalone).toBe('/skills save')
		}
	})

	it('is exhaustive over the effect kinds at the type level', () => {
		const kinds = (effect: TriggerEffect): string => {
			switch (effect.kind) {
				case 'turn-context':
				case 'turn-effort':
				case 'after-turn':
					return effect.kind
				default: {
					// A new kind stops compiling here until it is added to ALLOWED.
					const exhaustive: never = effect
					return exhaustive
				}
			}
		}
		expect(BUILTIN_TRIGGERS.map((trigger) => kinds(trigger.effect))).toHaveLength(4)
	})
})
