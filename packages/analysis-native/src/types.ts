/**
 * Shapes of the sidecar's protocol. Field names are the wire names; see
 * docs/sdk/native-analysis.md.
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

export interface Hello {
	name: string
	version: string
	protocol: number
	ops: NativeOp[]
	formats: string[]
	embedded: string[]
	bunLayouts: string[]
	limits: {
		maxRequestBytes: number
		maxFileBytes: number
		defaultMaxBytes: number
		maxMaxBytes: number
	}
}

/** Parameters every op that reads a file takes. */
export interface TargetParams {
	/** Path to a regular file. Symlinks to regular files are followed. */
	path: string
	/** For a universal Mach-O: which slice to read (default 0). */
	slice?: number
}

export interface SectionInfo {
	name: string
	segment: string | null
	address: number
	size: number
	fileOffset: number | null
	fileSize: number
	kind: string
	flags: string[]
	rawFlags: number
}

export interface SegmentInfo {
	name: string | null
	address: number
	size: number
	fileOffset: number
	fileSize: number
	permissions: string[]
	rawFlags: number
}

export interface FatSlice {
	index: number
	arch: string
	fileOffset: number
	size: number
}

export type EmbeddedPayload =
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

export interface BinaryInfo {
	format: BinaryFormat
	size: number
	/** False when the format was recognised (or not) but could not be read. */
	parsed: boolean
	note?: string
	slices?: FatSlice[]
	slice?: number
	kind?: 'executable' | 'shared' | 'relocatable' | 'core' | 'unknown'
	arch?: string
	bits?: 32 | 64
	endianness?: 'little' | 'big'
	entry?: number
	sectionCount?: number
	sections?: SectionInfo[]
	segments?: SegmentInfo[]
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
	embedded: EmbeddedPayload[]
}

export interface PageParams {
	/** Skip this many matches. */
	offset?: number
	/** Most items to return. */
	limit?: number
}

export interface SymbolsParams extends TargetParams, PageParams {
	which?: 'all' | 'static' | 'dynamic'
	/** Keep names containing this text, raw or demangled. */
	contains?: string
	kind?: 'function' | 'data' | 'tls' | 'other'
	definedOnly?: boolean
	/** Demangle C++, MSVC and Rust names (default true). */
	demangle?: boolean
}

export interface SymbolRecord {
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

export interface Page {
	total: number
	offset: number
	truncated: boolean
	/** Pass as `offset` to continue; null when everything was returned. */
	nextOffset: number | null
}

export interface SymbolsResult extends Page {
	symbols: SymbolRecord[]
}

export interface ImportsParams extends TargetParams, PageParams {
	contains?: string
	/** Keep only imports from this library. */
	library?: string
}

export interface ImportLibrary {
	name: string
	kind: 'needed' | 'dylib' | 'import-table' | 'delay-load'
	detail: unknown
}

export interface ImportRecord {
	name: string
	raw: string
	library: string | null
	ordinal: number | null
	weak: boolean
}

export interface ImportsResult extends Page {
	libraries: ImportLibrary[]
	imports: ImportRecord[]
	note?: string
}

export interface ExportRecord {
	name: string
	raw: string
	ordinal: number | null
	address: number | null
	forwardedTo: string | null
	weak: boolean
}

export interface ExportsResult extends Page {
	exports: ExportRecord[]
	note?: string
}

export interface StringsParams extends TargetParams {
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

export interface StringRecord {
	text: string
	/** Real length in characters, even when `text` was cut. */
	length: number
	truncated: boolean
	encoding: 'ascii' | 'utf16le'
	fileOffset: number
	section: string | null
	address: number | null
}

export interface StringsResult {
	strings: StringRecord[]
	/** True when the scan reached the end of the file. */
	complete: boolean
	nextCursor: number | null
	nextOffset: number | null
	/** Total matches; only known after a complete scan from the start. */
	total: number | null
	scannedBytes: number
}

export interface ExtractParams extends TargetParams {
	/** Directory to write into; it must not exist or must be empty. Omit to list only. */
	outDir?: string
	kind?: 'bun' | 'node-sea'
	/** `source` (default) skips binary assets; `all` writes every module. */
	include?: 'source' | 'all'
	includeBytecode?: boolean
	includeSourcemaps?: boolean
	/** Stop writing past this many bytes (default 1 GiB). */
	maxTotalBytes?: number
	offset?: number
	limit?: number
}

export interface ExtractedModule {
	/** Name inside the payload. */
	name: string
	size: number
	loader: string | null
	bytecodeSize: number
	/** Path relative to `outDir`, or null when not written. */
	path: string | null
	/** Why it was not written. */
	skipped: string | null
}

export interface ExtractResult {
	kind: 'bun' | 'node-sea'
	format: BinaryFormat
	outDir: string | null
	layout?: string
	bunVersion?: string | null
	entryPoint?: string
	entryPointId?: number
	flags?: number
	mainPath?: string | null
	note?: string | null
	moduleCount: number
	written: number
	writtenBytes: number
	skipped: number
	modules: ExtractedModule[]
	truncated: boolean
	nextOffset?: number
	provenance: { sourceSha256: string; sourceSize: number; format: BinaryFormat }
}

/** `ExtractResult` with the provenance a caller records beside the files. */
export interface ExtractedEmbedded extends ExtractResult {
	embeddedProvenance: EmbeddedProvenance
}

export interface EmbeddedProvenance {
	sourcePath: string
	sourceSha256: string
	sourceSize: number
	format: BinaryFormat
	kind: 'bun' | 'node-sea'
	bunVersion: string | null
	layout: string | null
	sidecarVersion: string
}
