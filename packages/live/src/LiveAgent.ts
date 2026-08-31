import type { LiveModel } from './types.js'

export interface LiveAgentOptions {
	readonly instructions: string
	readonly model: LiveModel
}

export class LiveAgent {
	readonly instructions: string
	readonly model: LiveModel

	constructor(options: LiveAgentOptions) {
		this.instructions = options.instructions
		this.model = options.model
	}
}
