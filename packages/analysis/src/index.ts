export { createCodeAnalysisProvider } from './provider.js'
export type { CodeAnalysisOptions } from './provider.js'
export {
	createNativeAnalysis,
	platformPackageName,
	resolveSidecar,
	SIDECAR_ENV,
	extractAsar,
	unsafeComponent,
	NativeAnalysisError,
	AsarError,
} from './native/index.js'
export type {
	NativeAnalysis,
	NativeAnalysisOptions,
	RequestOptions,
	NativeOp,
	ResolvedSidecar,
	SidecarSource,
	AsarEntryReport,
	AsarEntryStatus,
	AsarResult,
	ExtractAsarOptions,
} from './native/index.js'
export {
	DEFAULT_IGNORED_DIRS,
	DEFAULT_MAX_DIRECTORIES,
	DEFAULT_MAX_FILES,
	DEFAULT_MAX_FILE_BYTES,
	DEFAULT_MAX_MILLIS,
} from './indexer.js'
export type {
	AnalysisCallSite,
	AnalysisCoverage,
	AnalysisEnclosingFunction,
	AnalysisEvidence,
	AnalysisFunction,
	AnalysisFunctionKind,
	AnalysisFunctionSource,
	AnalysisLiteralHit,
	AnalysisModuleEdge,
	AnalysisPage,
	AnalysisPaging,
	AnalysisSourceSlice,
	CallersOfRequest,
	CodeAnalysisProvider,
	CodeAnalysisResult,
	EnclosingFunctionRequest,
	FindLiteralRequest,
	FunctionSourceRequest,
	ImportsRequest,
	IndexRequest,
	IndexSummary,
} from '@namzu/sdk'
