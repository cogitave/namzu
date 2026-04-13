import { type Logger, getRootLogger } from '../utils/logger.js'
import { Registry } from './Registry.js'

export interface ManagedRegistryConfig<TDefinition> {
	componentName: string
	idField?: keyof TDefinition & string
	/**
	 * Extract id from a full item. Takes precedence over `idField` when provided.
	 * Required when the id field is nested (e.g. `def.info.id`).
	 */
	computeId?: (item: TDefinition) => string
	logger?: Logger
}

export class ManagedRegistry<TDefinition> extends Registry<TDefinition> {
	protected log: Logger
	private idField?: keyof TDefinition & string
	private computeId?: (item: TDefinition) => string

	constructor(config: ManagedRegistryConfig<TDefinition>) {
		super()
		this.idField = config.idField
		this.computeId = config.computeId
		this.log = (config.logger ?? getRootLogger()).child({
			component: config.componentName,
		})
	}

	override register(id: string, item: TDefinition): void
	override register(item: TDefinition): void
	override register(items: TDefinition[]): void
	override register(idOrItem: string | TDefinition | TDefinition[], maybeItem?: TDefinition): void {
		if (Array.isArray(idOrItem)) {
			for (const item of idOrItem) {
				this.register(item)
			}
			return
		}

		if (typeof idOrItem === 'string') {
			if (!maybeItem) {
				throw new Error('register(id, item) requires an item argument')
			}
			const id = idOrItem
			const item = maybeItem
			if (this.has(id)) {
				this.log.warn(`"${id}" already registered, overwriting.`)
			}
			super.register(id, item)
			this.log.info(`Registered: ${id}`)
			return
		}

		const item = idOrItem
		const id = this.computeId
			? this.computeId(item)
			: this.idField
				? String(item[this.idField])
				: undefined
		if (id === undefined) {
			throw new Error('register(item) requires idField or computeId to be configured')
		}

		if (this.has(id)) {
			this.log.warn(`"${id}" already registered, overwriting.`)
		}
		super.register(id, item)
		this.log.info(`Registered: ${id}`)
	}

	getOrThrow(id: string): TDefinition {
		const item = this.get(id)
		if (!item) {
			throw new Error(`Not found: "${id}". Available: ${this.listIds().join(', ')}`)
		}
		return item
	}
}
