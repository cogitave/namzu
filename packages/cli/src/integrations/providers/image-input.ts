import { type LLMProvider, modelReadsImages } from '@namzu/sdk'

/**
 * Models this conversation has learned cannot read images, keyed by provider
 * and model. The kernel finds one out the hard way, when a provider refuses a
 * request that held an image; remembering it here is what keeps the next turn
 * from making the same refused request first.
 */
export class TextOnlyModels {
	private readonly known = new Set<string>()

	private key(providerId: string, model: string): string {
		return `${providerId}/${model}`
	}

	add(providerId: string, model: string): void {
		this.known.add(this.key(providerId, model))
	}

	has(providerId: string, model: string): boolean {
		return this.known.has(this.key(providerId, model))
	}

	/** Whether a request for `model` through `provider` may carry images. */
	reads(provider: LLMProvider, model: string): boolean {
		return !this.has(provider.id, model) && modelReadsImages(provider, model)
	}

	/**
	 * `provider`, answering for what this conversation has learned. A proxy and
	 * not a copy, so every other member (private state, later-added methods)
	 * stays the provider's own.
	 */
	informing(provider: LLMProvider): LLMProvider {
		const known = this
		return new Proxy(provider, {
			get(target, property) {
				if (property === 'supportsImageInputFor') {
					return (model: string) =>
						!known.has(target.id, model) && (target.supportsImageInputFor?.(model) ?? true)
				}
				const value: unknown = Reflect.get(target, property, target)
				return typeof value === 'function' ? value.bind(target) : value
			},
		})
	}
}
