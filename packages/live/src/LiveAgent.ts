import type { LiveModel } from './types.js'

export interface LiveAgentOptions {
	readonly id?: string
	readonly instructions: string
	readonly model: LiveModel
	readonly name?: string
}

export class LiveAgent {
	readonly id: string
	readonly instructions: string
	readonly model: LiveModel
	readonly name: string

	constructor(options: LiveAgentOptions) {
		this.id = options.id ?? 'live_agent'
		this.instructions = options.instructions
		this.model = options.model
		this.name = options.name ?? 'Live agent'
	}
}
