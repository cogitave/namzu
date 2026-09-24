import { BaseRegistry } from '../registry/BaseRegistry.js'
import { RegistryCollisionError } from '../registry/collision.js'
import type { AdvisorDefinition } from '../types/advisory/index.js'

/** Two advisors claiming one id. */
export class AdvisorCollisionError extends RegistryCollisionError {
	readonly advisorId: string

	constructor(advisorId: string) {
		super(
			'AdvisorRegistry',
			advisorId,
			`Advisor "${advisorId}" is already registered. Two advisors picked the same id, or the same advisor was registered twice — pick a different id, or find the second registration.`,
		)
		this.name = 'AdvisorCollisionError'
		this.advisorId = advisorId
	}
}

export class AdvisorRegistry extends BaseRegistry<AdvisorDefinition> {
	private readonly defaultId: string | undefined

	constructor(advisors: AdvisorDefinition[], defaultId?: string) {
		super()
		for (const advisor of advisors) {
			this.register(advisor.id, advisor)
		}
		this.defaultId = defaultId
	}

	/**
	 * A second advisor claiming an id an earlier one already holds used to
	 * overwrite in total silence (see
	 * `gaps/critic-registry-collision-idiom-inconsistency.md`). Every SDK
	 * registry now throws on a duplicate id by default (see
	 * `registry/collision.ts`), and this one had no exception to name, so it
	 * converges too: two advisors sharing an id is a configuration mistake,
	 * not a supersession, and the loser vanishing silently is exactly the
	 * failure this now refuses instead of logging.
	 */
	override register(id: string, advisor: AdvisorDefinition): void {
		if (this.has(id)) {
			throw new AdvisorCollisionError(id)
		}
		super.register(id, advisor)
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
