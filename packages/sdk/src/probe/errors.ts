import { RegistryCollisionError } from '../registry/collision.js'
import type { VetoableEventKind } from '../types/probe/index.js'

export class ProbeNameCollisionError extends RegistryCollisionError {
	readonly probeName: string

	constructor(probeName: string) {
		super(
			'ProbeRegistry',
			probeName,
			`Probe name "${probeName}" is already registered. Pass { override: true } to replace, or pick a different name.`,
		)
		this.name = 'ProbeNameCollisionError'
		this.probeName = probeName
	}
}

export class ProbeVetoError extends Error {
	readonly probeName: string
	readonly reason: string
	readonly eventKind: VetoableEventKind

	constructor(probeName: string, reason: string, eventKind: VetoableEventKind) {
		super(`Operation denied by probe "${probeName}" on ${eventKind}: ${reason}`)
		this.name = 'ProbeVetoError'
		this.probeName = probeName
		this.reason = reason
		this.eventKind = eventKind
	}
}
