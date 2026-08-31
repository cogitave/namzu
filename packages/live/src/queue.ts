interface QueueItem<T> {
	readonly value: T
	readonly weight: number
}

interface PendingReader<T> {
	readonly reject: (error: unknown) => void
	readonly resolve: (result: IteratorResult<T>) => void
}

interface PendingWriter<T> extends QueueItem<T> {
	cleanup?(): void
	readonly reject: (error: unknown) => void
	resolve(): void
}

export class WeightedAsyncQueue<T> implements AsyncIterableIterator<T> {
	private closed = false
	private error: unknown
	private readonly items: QueueItem<T>[] = []
	private readonly readers: PendingReader<T>[] = []
	private totalWeight = 0
	private readonly writers: PendingWriter<T>[] = []

	constructor(readonly capacity: number) {
		if (!Number.isFinite(capacity) || capacity <= 0) {
			throw new RangeError('Queue capacity must be a positive finite number.')
		}
	}

	get weight(): number {
		return this.totalWeight
	}

	canPush(weight: number): boolean {
		return !this.closed && weight >= 0 && weight <= this.capacity - this.totalWeight
	}

	tryPush(value: T, weight: number): boolean {
		this.assertWeight(weight)
		if (this.closed || !this.canPush(weight)) return false
		const reader = this.readers.shift()
		if (reader) {
			reader.resolve({ done: false, value })
			return true
		}
		this.items.push({ value, weight })
		this.totalWeight += weight
		return true
	}

	push(value: T, weight: number, signal?: AbortSignal): Promise<void> {
		this.assertWeight(weight)
		if (signal?.aborted) return Promise.reject(signal.reason)
		if (this.tryPush(value, weight)) return Promise.resolve()
		if (this.closed) return Promise.reject(this.error ?? new Error('Queue is closed.'))
		if (weight > this.capacity) {
			return Promise.reject(new RangeError('Queue item exceeds queue capacity.'))
		}

		return new Promise<void>((resolve, reject) => {
			const writer: PendingWriter<T> = { value, weight, resolve, reject }
			this.writers.push(writer)
			if (!signal) return
			const onAbort = () => {
				const index = this.writers.indexOf(writer)
				if (index < 0) return
				this.writers.splice(index, 1)
				writer.cleanup?.()
				reject(signal.reason)
			}
			signal.addEventListener('abort', onAbort, { once: true })
			writer.cleanup = () => signal.removeEventListener('abort', onAbort)
		})
	}

	close(error?: unknown): void {
		if (this.closed) return
		this.closed = true
		this.error = error
		for (const writer of this.writers.splice(0)) {
			writer.cleanup?.()
			writer.reject(error ?? new Error('Queue closed before the item was consumed.'))
		}
		if (error !== undefined) {
			this.items.length = 0
			this.totalWeight = 0
			for (const reader of this.readers.splice(0)) reader.reject(error)
			return
		}
		if (this.items.length === 0) {
			for (const reader of this.readers.splice(0)) reader.resolve({ done: true, value: undefined })
		}
	}

	next(): Promise<IteratorResult<T>> {
		const item = this.items.shift()
		if (item) {
			this.totalWeight -= item.weight
			this.refill()
			return Promise.resolve({ done: false, value: item.value })
		}
		if (this.closed) {
			return this.error === undefined
				? Promise.resolve({ done: true, value: undefined })
				: Promise.reject(this.error)
		}
		return new Promise<IteratorResult<T>>((resolve, reject) => {
			this.readers.push({ resolve, reject })
		})
	}

	return(): Promise<IteratorResult<T>> {
		this.close()
		return Promise.resolve({ done: true, value: undefined })
	}

	[Symbol.asyncIterator](): AsyncIterableIterator<T> {
		return this
	}

	private assertWeight(weight: number): void {
		if (!Number.isFinite(weight) || weight < 0) {
			throw new RangeError('Queue item weight must be finite and non-negative.')
		}
	}

	private refill(): void {
		while (this.writers.length > 0) {
			const writer = this.writers[0]
			if (!writer || writer.weight > this.capacity - this.totalWeight) return
			this.writers.shift()
			const reader = this.readers.shift()
			if (reader) reader.resolve({ done: false, value: writer.value })
			else {
				this.items.push({ value: writer.value, weight: writer.weight })
				this.totalWeight += writer.weight
			}
			writer.cleanup?.()
			writer.resolve()
		}
	}
}
