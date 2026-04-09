export class Registry<TDefinition> {
	protected items: Map<string, TDefinition> = new Map()

	register(id: string, item: TDefinition): void {
		this.items.set(id, item)
	}

	get(id: string): TDefinition | undefined {
		return this.items.get(id)
	}

	has(id: string): boolean {
		return this.items.has(id)
	}

	getAll(): TDefinition[] {
		return Array.from(this.items.values())
	}

	listIds(): string[] {
		return Array.from(this.items.keys())
	}

	unregister(id: string): boolean {
		return this.items.delete(id)
	}

	clear(): void {
		this.items.clear()
	}

	size(): number {
		return this.items.size
	}
}
