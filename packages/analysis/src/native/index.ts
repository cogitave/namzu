export {
	createNativeAnalysis,
	type NativeAnalysis,
	type NativeAnalysisOptions,
	type RequestOptions,
} from './client.js'
	export { NativeAnalysisError } from './errors.js'
export {
	createNativeAnalysisProvider,
	type NativeAnalysisProviderOptions,
} from './provider.js'
export {
	platformPackageName,
	resolveSidecar,
	SIDECAR_ENV,
	type ResolveOptions,
	type ResolvedSidecar,
	type SidecarSource,
} from './resolve.js'
export {
	AsarError,
	extractAsar,
	unsafeComponent,
	type AsarEntryReport,
	type AsarEntryStatus,
	type AsarResult,
	type ExtractAsarOptions,
} from './asar.js'
export type * from './types.js'
