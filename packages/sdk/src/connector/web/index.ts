// Reaching the web, as a seam. Fetching is implemented here because its
// rules are about the network and the same everywhere; searching is not,
// and ships with no vendor. See `types.ts` for why that asymmetry is the
// design rather than an omission.
export { GuardedFetchProvider, isPrivateAddress } from './guarded-fetch.js'
export type { GuardedFetchConfig } from './guarded-fetch.js'
export { WebFetchRefusedError } from './types.js'
export type {
	WebFetchProvider,
	WebFetchRefusalReason,
	WebFetchRequest,
	WebFetchResult,
	WebSearchHit,
	WebSearchProvider,
	WebSearchRequest,
	WebSearchResult,
} from './types.js'
