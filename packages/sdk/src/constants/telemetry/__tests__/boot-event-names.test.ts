import { describe, expect, it } from 'vitest'
import { BOOT_EVENT_NAMES } from '../index.js'
import type { BootEventName } from '../index.js'

describe('BOOT_EVENT_NAMES / BootEventName', () => {
	it('every constant is a member of the union and the union has no member without a constant', () => {
		const exhaustive: Record<BootEventName, true> = {
			'namzu.boot.start': true,
			'namzu.config.resolved': true,
			'namzu.sandbox.resolved': true,
			'namzu.provider.resolved': true,
			'namzu.capability.detected': true,
			'namzu.capability.broken': true,
			'namzu.telemetry.status': true,
			'namzu.migration.completed': true,
			'namzu.discovery.completed': true,
			'namzu.boot.refused': true,
			'namzu.boot.ready': true,
		}

		expect(Object.keys(exhaustive).sort()).toEqual(Object.values(BOOT_EVENT_NAMES).sort())
	})
})
