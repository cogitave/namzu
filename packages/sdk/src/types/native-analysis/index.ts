/**
 * The seam a native binary lane arrives on.
 *
 * Same split as `CodeAnalysisProvider`: declared in the SDK and implemented
 * in `@namzu/analysis` (whose Rust sidecar does the reading), because the
 * dependency direction forbids the SDK importing the package (`sdk ←
 * analysis`, never the other way). A host constructs one and puts it on the
 * tool context; there is no discovery step. The shapes are the sidecar's
 * wire shapes: `binary_analysis` answers exactly what the process answers.
 *
 * What this answers that reading a file's bytes does not: which format an
 * executable is (ELF/PE/Mach-O), its symbols and strings, where its
 * JavaScript payload sits (a Bun `--compile` build, a Node SEA) and what the
 * sections and imports say it loads. Read-only: no op executes or loads the
 * target.
 */

export type NativeOp =
	| 'hello'
	| 'binary_info'
	| 'symbols'
	| 'imports'
	| 'exports'
	| 'strings'
	| 'extract_embedded'

export type BinaryFormat =
	| 'elf'
	| 'pe'
	| 'macho'
	| 'macho-fat'
	| 'coff'
	| 'coff-import'
	| 'archive'
	| 'dyld-cache'
	| 'xcoff'
	| 'other'
	| 'unknown'

/** Parameters every op that reads a file takes. */
export interface NativeTargetParams {
	/** Path to a regular file. Symlinks to regular files are followed. */
	readonly path: string
	/** For a universal Mach-O: which slice to read (default 0). */
	readonly slice?: number
}

export interface NativePageParams {
	/** Skip this many matches. */
	readonly offset?: number
	/** Most items to return. */
	readonly limit?: number
}

export interface NativeSectionInfo {
	name: string
	segment: string | null
	address: number
	size: number
	fileOffset: number | null
	fileSize: number
	kind: string
	flags: string[]
}

export interface NativeSegmentInfo {
	name: string | null
	address: number
	size: number
	fileOffset: number
	fileSize: number
	permissions: string[]
}

export interface NativeFatSlice {
	index: number
	arch: string
	fileOffset: number
	size: number
}

export type NativeEmbeddedPayload =
	| {
			kind: 'bun'
			valid: true
			layout: string
			bunVersion: string | null
			modules: number
			javascriptModules: number
			bytecodeModules: number
			extractable: true
	  }
	| { kind: 'bun'; valid: false; reason: string; extractable: false }
	| {
			kind: 'node-sea'
			blobSize: number
			flags: number
			mainPath: string | null
			mainScriptSize: number | null
			assets: number
			note: string | null
			extractable: true
	  }
	| { kind: 'go-buildinfo'; extractable: false; note: string }

export interface NativeBinaryInfo {
	format: BinaryFormat
	size: number
	/** False when the format was recognised (or not) but could not be read. */
	parsed: boolean
	note?: string
	slices?: NativeFatSlice[]
	slice?: number
	kind?: 'executable' | 'shared' | 'relocatable' | 'core' | 'unknown'
	arch?: string
	bits?: 32 | 64
	endianness?: 'little' | 'big'
	entry?: number
	sectionCount?: number
	sections?: NativeSectionInfo[]
	segments?: NativeSegmentInfo[]
	/** ELF GNU build id, hex. */
	buildId?: string
	/** Mach-O LC_UUID, hex. */
	machoUuid?: string
	/** PE COFF header timestamp (seconds since the epoch). */
	peTimestamp?: number
	isDll?: boolean
	subsystem?: number
	pdb?: { path: string; guid: string; age: number }
	/** True when the file has no static symbol table. */
	stripped?: boolean
	dynamicSymbols?: boolean
	debugInfo?: boolean
	embedded: NativeEmbeddedPayload[]
}

export interface NativeSymbolsParams extends NativeTargetParams, NativePageParams {
	which?: 'all' | 'static' | 'dynamic'
	/** Keep names containing this text, raw or demangled. */
	contains?: string
	kind?: 'function' | 'data' | 'tls' | 'other'
	definedOnly?: boolean
	/** Demangle C++, MSVC and Rust names (default true). */
	demangle?: boolean
}

export interface NativeSymbolRecord {
	/** Demangled when the raw name was mangled. */
	name: string
	raw: string
	language: 'cpp' | 'msvc' | 'rust' | null
	kind: 'function' | 'data' | 'tls' | 'other'
	address: number
	size: number
	source: 'static' | 'dynamic'
	undefined: boolean
	binding: 'global' | 'local' | 'weak' | 'unknown'
	section: string | null
}

export interface NativePage {
	total: number
	offset: number
	truncated: boolean
	/** Pass as `offset` to continue; null when everything was returned. */
	nextOffset: number | null
}

export interface NativeSymbolsResult extends NativePage {
	symbols: NativeSymbolRecord[]
}

export interface NativeImportsParams extends NativeTargetParams, NativePageParams {
	contains?: string
	/** Keep only imports from this library. */
	library?: string
}

export interface NativeImportLibrary {
	name: string
	kind: 'needed' | 'dylib' | 'import-table' | 'delay-load'
}

export interface NativeImportRecord {
	name: string
	raw: string
	library: string | null
	ordinal: number | null
	weak: boolean
}

export interface NativeImportsResult extends NativePage {
	libraries: NativeImportLibrary[]
	imports: NativeImportRecord[]
}

export interface NativeExportRecord {
	name: string
	raw: string
	ordinal: number | null
	address: number | null
	forwardedTo: string | null
	weak: boolean
}

export interface NativeExportsResult extends NativePage {
	exports: NativeExportRecord[]
}

export interface NativeStringsParams extends NativeTargetParams {
	/** Shortest run reported (default 4, minimum 2). */
	minLength?: number
	encodings?: Array<'ascii' | 'utf16le'>
	contains?: string
	/** Keep only strings inside this section. */
	section?: string
	/** Longest text returned per string (default 1024). */
	maxStringLength?: number
	offset?: number
	/** File offset to start at: the previous page's `nextCursor`. */
	cursor?: number
	limit?: number
}

export interface NativeStringRecord {
	text: string
	/** Real length in characters, even when `text` was cut. */
	length: number
	truncated: boolean
	encoding: 'ascii' | 'utf16le'
	fileOffset: number
	section: string | null
	address: number | null
}

export interface NativeStringsResult {
	strings: NativeStringRecord[]
	/** True when the scan reached the end of the file. */
	complete: boolean
	nextCursor: number | null
	nextOffset: number | null
	/** Total matches; only known after a complete scan from the start. */
	total: number | null
	scannedBytes: number
}

/**
 * A read over one file, backed by a sidecar process the host does not hold
 * open until asked. Errors surface as thrown values carrying the sidecar's
 * code (`unsupported_format`, `too_large`, `deadline_exceeded`, ...), not as
 * a result variant: an answer that did not happen is unknown, never empty.
 */
export interface NativeAnalysisProvider {
	/** Format, kind, architecture, sections and embedded payloads of a file. */
	binaryInfo(params: NativeTargetParams): Promise<NativeBinaryInfo>
	/** Symbols, static or dynamic, demangled, filtered and paged. */
	symbols(params: NativeSymbolsParams): Promise<NativeSymbolsResult>
	/** Import libraries and imported symbols. */
	imports(params: NativeImportsParams): Promise<NativeImportsResult>
	/** Exported symbols. */
	exports(params: NativeImportsParams): Promise<NativeExportsResult>
	/** Printable runs over the file, in offset order, cursored by file offset. */
	strings(params: NativeStringsParams): Promise<NativeStringsResult>
	/** Stop the process behind it. Not optional: a live child is a held process. */
	dispose(): Promise<void>
}
