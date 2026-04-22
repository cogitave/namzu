export class ProbeNameCollisionError extends Error {
	readonly probeName: string

	constructor(probeName: string) {
		super(
			`Probe name "${probeName}" is already registered. Pass { override: true } to replace, or pick a different name.`,
		)
		this.name = 'ProbeNameCollisionError'
		this.probeName = probeName
	}
}
