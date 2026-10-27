import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

import type { NamzuCliConfig } from '../../config/schema.js'
import { discoverProviders } from '../../integrations/providers/discover.js'
import {
	describeCacheLifetime,
	providerOffersCacheLifetime,
} from '../../integrations/providers/prompt-cache-ttl.js'

/**
 * How long the provider is asked to keep the prompt cache, and whether a
 * longer one is worth suggesting.
 *
 * A `pass` in both directions, like the session-export row: the five-minute
 * default is the right setting for most work and costs less per write, so
 * reporting it as a warning would flag a healthy machine. The row's job is to
 * put the choice in front of someone whose sessions are long, or who pauses
 * for more than five minutes at a time, because for them the cache goes cold
 * between turns and every turn pays to rebuild it.
 *
 * It says nothing where no provider here lets the lifetime be chosen: a
 * setting nothing honours is not worth a line.
 */
export async function describeCacheLifetimeStatus(
	config: NamzuCliConfig,
	offered: (env: NodeJS.ProcessEnv) => Promise<boolean>,
	env: NodeJS.ProcessEnv,
): Promise<DoctorCheckResult> {
	if (!(await offered(env))) {
		return {
			status: 'skipped',
			message: 'No connected provider lets the prompt cache lifetime be chosen.',
		}
	}
	const ttl = config.compaction?.promptCacheTtl
	if (ttl === '1h') {
		return { status: 'pass', message: `Prompt cache lifetime is ${describeCacheLifetime(ttl)}.` }
	}
	return {
		status: 'pass',
		message: `Prompt cache lifetime is ${describeCacheLifetime(ttl)}. For long sessions, or when you often pause for more than five minutes, a longer one keeps the cache warm between turns.`,
		remediation:
			'Set compaction.promptCacheTtl to "1h" in your Namzu config. Writing a one-hour cache costs more than a five-minute one.',
	}
}

async function anyProviderOffersLifetime(env: NodeJS.ProcessEnv): Promise<boolean> {
	const detected = await discoverProviders({ env })
	return detected.some((provider) => providerOffersCacheLifetime(provider.entry.id))
}

export function cacheLifetimeCheck(config: NamzuCliConfig): DoctorCheck {
	return {
		id: 'providers.cache-lifetime',
		category: 'providers',
		run: async (ctx): Promise<DoctorCheckResult> => {
			try {
				return await describeCacheLifetimeStatus(
					config,
					anyProviderOffersLifetime,
					ctx.env as NodeJS.ProcessEnv,
				)
			} catch (error) {
				return {
					status: 'inconclusive',
					message: `could not tell which providers are connected: ${error instanceof Error ? error.message : String(error)}`,
				}
			}
		},
	}
}
