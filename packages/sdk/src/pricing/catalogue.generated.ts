// GENERATED FILE — DO NOT EDIT.
//
// Produced by `node scripts/generate-model-prices.mjs` from
// `packages/sdk/src/pricing/rates.source.json`, which is the file to edit.
// CI re-runs the generator and fails on any difference, so a hand edit here is
// reverted by the next run at best and reported as drift at worst.
//
// 4 vendors, 32 priced models.

import type { ModelPricing } from '../utils/cost.js'

export interface VendorRates {
	/** Matched against `LLMProvider.id`. */
	readonly providerId: string
	/**
	 * This driver bills nothing for a token, whatever the model — local
	 * inference. Its runs are priced at zero, which is KNOWN-free and so
	 * distinct from a model nobody has a rate for.
	 */
	readonly unmetered: boolean
	/** Keyed by normalised model id. Empty when `unmetered`. */
	readonly models: ReadonlyMap<string, ModelPricing>
}

export const VENDOR_RATES: readonly VendorRates[] = [
	{
		providerId: 'anthropic',
		unmetered: false,
		models: new Map([
			[
				'claude-fable-5',
				{
					inputCostPer1M: 10,
					outputCostPer1M: 50,
					cache: { promptIncludesCacheReads: false, readCostPer1M: 1, writeCostPer1M: 12.5 },
				},
			],
			[
				'claude-haiku-4-5',
				{
					inputCostPer1M: 1,
					outputCostPer1M: 5,
					cache: { promptIncludesCacheReads: false, readCostPer1M: 0.1, writeCostPer1M: 1.25 },
				},
			],
			[
				'claude-mythos-5',
				{
					inputCostPer1M: 10,
					outputCostPer1M: 50,
					cache: { promptIncludesCacheReads: false, readCostPer1M: 1, writeCostPer1M: 12.5 },
				},
			],
			[
				'claude-opus-4-1',
				{
					inputCostPer1M: 15,
					outputCostPer1M: 75,
					cache: { promptIncludesCacheReads: false, readCostPer1M: 1.5, writeCostPer1M: 18.75 },
				},
			],
			[
				'claude-opus-4-6',
				{
					inputCostPer1M: 5,
					outputCostPer1M: 25,
					cache: { promptIncludesCacheReads: false, readCostPer1M: 0.5, writeCostPer1M: 6.25 },
				},
			],
			[
				'claude-opus-4-7',
				{
					inputCostPer1M: 5,
					outputCostPer1M: 25,
					cache: { promptIncludesCacheReads: false, readCostPer1M: 0.5, writeCostPer1M: 6.25 },
				},
			],
			[
				'claude-opus-4-8',
				{
					inputCostPer1M: 5,
					outputCostPer1M: 25,
					cache: { promptIncludesCacheReads: false, readCostPer1M: 0.5, writeCostPer1M: 6.25 },
				},
			],
			[
				'claude-opus-5',
				{
					inputCostPer1M: 5,
					outputCostPer1M: 25,
					cache: { promptIncludesCacheReads: false, readCostPer1M: 0.5, writeCostPer1M: 6.25 },
				},
			],
			[
				'claude-sonnet-4-5',
				{
					inputCostPer1M: 3,
					outputCostPer1M: 15,
					cache: { promptIncludesCacheReads: false, readCostPer1M: 0.3, writeCostPer1M: 3.75 },
				},
			],
			[
				'claude-sonnet-4-6',
				{
					inputCostPer1M: 3,
					outputCostPer1M: 15,
					cache: { promptIncludesCacheReads: false, readCostPer1M: 0.3, writeCostPer1M: 3.75 },
				},
			],
			[
				'claude-sonnet-5',
				{
					inputCostPer1M: 3,
					outputCostPer1M: 15,
					cache: { promptIncludesCacheReads: false, readCostPer1M: 0.3, writeCostPer1M: 3.75 },
				},
			],
		]),
	},
	{
		providerId: 'lmstudio',
		unmetered: true,
		models: new Map([
			// none — see `unmetered`.
		]),
	},
	{
		providerId: 'ollama',
		unmetered: true,
		models: new Map([
			// none — see `unmetered`.
		]),
	},
	{
		providerId: 'openai',
		unmetered: false,
		models: new Map([
			[
				'gpt-4.1',
				{
					inputCostPer1M: 2,
					outputCostPer1M: 8,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 0.5 },
				},
			],
			[
				'gpt-4.1-mini',
				{
					inputCostPer1M: 0.4,
					outputCostPer1M: 1.6,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 0.1 },
				},
			],
			[
				'gpt-4.1-nano',
				{
					inputCostPer1M: 0.1,
					outputCostPer1M: 0.4,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 0.025 },
				},
			],
			[
				'gpt-4o',
				{
					inputCostPer1M: 2.5,
					outputCostPer1M: 10,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 1.25 },
				},
			],
			[
				'gpt-4o-mini',
				{
					inputCostPer1M: 0.15,
					outputCostPer1M: 0.6,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 0.075 },
				},
			],
			[
				'gpt-5',
				{
					inputCostPer1M: 1.25,
					outputCostPer1M: 10,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 0.125 },
				},
			],
			[
				'gpt-5-mini',
				{
					inputCostPer1M: 0.25,
					outputCostPer1M: 2,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 0.025 },
				},
			],
			[
				'gpt-5-nano',
				{
					inputCostPer1M: 0.05,
					outputCostPer1M: 0.4,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 0.005 },
				},
			],
			[
				'gpt-5.1',
				{
					inputCostPer1M: 1.25,
					outputCostPer1M: 10,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 0.125 },
				},
			],
			[
				'gpt-5.2',
				{
					inputCostPer1M: 1.75,
					outputCostPer1M: 14,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 0.175 },
				},
			],
			[
				'gpt-5.4',
				{
					inputCostPer1M: 2.5,
					outputCostPer1M: 15,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 0.25 },
				},
			],
			[
				'gpt-5.4-mini',
				{
					inputCostPer1M: 0.75,
					outputCostPer1M: 4.5,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 0.075 },
				},
			],
			[
				'gpt-5.4-nano',
				{
					inputCostPer1M: 0.2,
					outputCostPer1M: 1.25,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 0.02 },
				},
			],
			[
				'gpt-5.5',
				{
					inputCostPer1M: 5,
					outputCostPer1M: 30,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 0.5 },
				},
			],
			[
				'gpt-5.6-luna',
				{
					inputCostPer1M: 0.2,
					outputCostPer1M: 1.2,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 0.02 },
				},
			],
			[
				'gpt-5.6-sol',
				{
					inputCostPer1M: 5,
					outputCostPer1M: 30,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 0.5 },
				},
			],
			[
				'gpt-5.6-terra',
				{
					inputCostPer1M: 2,
					outputCostPer1M: 12,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 0.2 },
				},
			],
			[
				'o1',
				{
					inputCostPer1M: 15,
					outputCostPer1M: 60,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 7.5 },
				},
			],
			[
				'o3',
				{
					inputCostPer1M: 2,
					outputCostPer1M: 8,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 0.5 },
				},
			],
			[
				'o3-mini',
				{
					inputCostPer1M: 1.1,
					outputCostPer1M: 4.4,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 0.55 },
				},
			],
			[
				'o4-mini',
				{
					inputCostPer1M: 1.1,
					outputCostPer1M: 4.4,
					cache: { promptIncludesCacheReads: true, readCostPer1M: 0.275 },
				},
			],
		]),
	},
]
