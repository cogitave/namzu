import type {
	HostCommandContext,
	HostCommandDescriptor,
	HostCommandOutcome,
	SerializableHostCommand,
} from '../../types/command/index.js'
import { ManagedRegistry } from '../ManagedRegistry.js'

/**
 * A second command claiming a name that is already taken.
 *
 * Its own class rather than a bare `Error`, for the reason
 * `ToolNameCollisionError` gives: a host that wants to decide what to do —
 * skip, rename, refuse to boot — has to catch it narrowly instead of
 * matching on message text.
 */
export class HostCommandNameCollisionError extends Error {
	readonly commandName: string

	constructor(commandName: string) {
		super(
			`Host command "/${commandName}" is already registered. Two commands answering to one name shadow each other silently, and which one wins depends on registration order.`,
		)
		this.name = 'HostCommandNameCollisionError'
		this.commandName = commandName
	}
}

/**
 * The commands a host offers its operator, held where the kernel can fill
 * them.
 *
 * `ManagedRegistry` for the id handling and the logging, with the
 * collision policy tightened: the base class WARNS and overwrites, which is
 * right for a tool roster a host assembles deliberately and wrong here.
 * These are operator-facing, and a shadowed command is invisible — it does
 * not fail, it simply never runs, and the one that wins depends on
 * registration order. `ToolRegistry` reaches the same conclusion for the
 * same reason one directory over.
 */
export class HostCommandRegistry extends ManagedRegistry<HostCommandDescriptor> {
	constructor(logger?: ConstructorParameters<typeof ManagedRegistry>[0]['logger']) {
		super({ componentName: 'host-commands', idField: 'name', ...(logger ? { logger } : {}) })
	}

	override register(id: string, item: HostCommandDescriptor): void
	override register(item: HostCommandDescriptor): void
	override register(items: HostCommandDescriptor[]): void
	override register(
		idOrItem: string | HostCommandDescriptor | HostCommandDescriptor[],
		maybeItem?: HostCommandDescriptor,
	): void {
		if (Array.isArray(idOrItem)) {
			for (const item of idOrItem) this.register(item)
			return
		}
		const name = typeof idOrItem === 'string' ? idOrItem : idOrItem.name
		if (this.has(name)) throw new HostCommandNameCollisionError(name)
		if (typeof idOrItem === 'string') {
			if (!maybeItem) throw new Error('register(id, item) requires an item argument')
			super.register(idOrItem, maybeItem)
			return
		}
		super.register(idOrItem)
	}

	/**
	 * Run a command line, or say this is not one of ours.
	 *
	 * `undefined` for an unknown name, and that is not the same as
	 * `refused`. A host layers its own commands under the kernel's — an
	 * operator's `.md` files, a TUI's `/clear` — and needs "not mine, keep
	 * looking" to be distinguishable from "mine, and no". Collapsing the two
	 * makes every host command below this registry unreachable.
	 */
	async dispatch(
		raw: string,
		ctx?: Partial<HostCommandContext>,
	): Promise<HostCommandOutcome | undefined> {
		const trimmed = raw.trim()
		if (!trimmed.startsWith('/')) return undefined
		const [name, ...args] = trimmed.slice(1).split(/\s+/)
		if (!name) return undefined

		const command = this.get(name)
		if (!command) return undefined

		return command.handler({ args: ctx?.args ?? args })
	}

	/**
	 * Every command, without its handler.
	 *
	 * Stripped rather than merely "not usually read": this is what crosses a
	 * process boundary, and a function-valued key survives neither
	 * `JSON.stringify` nor `structuredClone` — the first drops it silently,
	 * the second throws. Removing it here means a host gets the same
	 * descriptor either way.
	 */
	describe(): readonly SerializableHostCommand[] {
		return this.getAll()
			.map(({ handler: _handler, ...rest }) => rest)
			.sort((a, b) => a.name.localeCompare(b.name))
	}
}
