export interface PalSceneResource {
	readonly valid: boolean
	/** Detach the canvas and retire all work tied to its former visible owner. */
	suspend(): void
	dispose(): void
}

export interface PalSceneLease<T> {
	readonly scene: T
	release(discard?: boolean): void
}

/** Only idle decorative scenes are reusable; active views always have an exclusive lease. */
export class PalScenePool<T extends PalSceneResource> {
	private idle: { key: string; scene: T }[] = []
	constructor(private readonly maximumIdle = 2) {}

	acquire(key: string, create: () => T): PalSceneLease<T> {
		for (const item of [...this.idle]) if (!item.scene.valid) this.discard(item.scene)
		const index = this.idle.findIndex((item) => item.key === key)
		const scene = index < 0 ? create() : (this.idle.splice(index, 1)[0] as { scene: T }).scene
		let released = false
		return {
			scene,
			release: (discard = false) => {
				if (released) return
				released = true
				scene.suspend()
				if (discard || !scene.valid || this.maximumIdle < 1) {
					this.discard(scene)
					return
				}
				this.idle.push({ key, scene })
				while (this.idle.length > this.maximumIdle) this.idle.shift()?.scene.dispose()
			},
		}
	}

	discard(scene: T): void {
		this.idle = this.idle.filter((item) => item.scene !== scene)
		scene.dispose()
	}

	clear(): void {
		const idle = this.idle
		this.idle = []
		for (const item of idle) item.scene.dispose()
	}
}
