import { Registry } from '../registry/Registry.js'
import type { AdvisorDefinition } from '../types/advisory/index.js'

export class AdvisorRegistry extends Registry<AdvisorDefinition> {
	private readonly defaultId: string | undefined

	constructor(advisors: AdvisorDefinition[], defaultId?: string) {
		super()
		for (const advisor of advisors) {
			this.register(advisor.id, advisor)
		}
		this.defaultId = defaultId
	}

	/**
	 * Resolves the advisor for a given request.
	 *
	 * Priority: explicit ID > domain match > default > first registered.
	 */
	resolve(advisorId?: string, domain?: string): AdvisorDefinition | undefined {
		if (advisorId) {
			return this.get(advisorId)
		}

		if (domain) {
			const all = this.getAll()
			const match = all.find((a) => a.domains?.some((d) => d === domain))
			if (match) return match
		}

		if (this.defaultId) {
			return this.get(this.defaultId)
		}

		const all = this.getAll()
		return all.length > 0 ? all[0] : undefined
	}

	listAll(): AdvisorDefinition[] {
		return this.getAll()
	}
}
