/**
 * A real language server, built on the TypeScript language service.
 *
 * ## Why this exists rather than a packaged server
 *
 * The property the integration test has to hold is that a grep-backed fake
 * would FAIL it: `references` must find the call site that arrives through a
 * re-export, and must not find the identifier sitting in a comment or a
 * string. That is symbol resolution, and only a real one has it.
 *
 * A packaged language server would supply it and would also add a
 * third-party runtime dependency to this repository for the sake of one
 * test. `typescript` is already here — every package builds with it — and
 * `ts.LanguageService` is the same resolver the compiler uses. So the
 * answers below are genuinely resolved: this file is a thin LSP wire over a
 * real service, not a fixture that returns what the test expects.
 *
 * It speaks the real wire too — `Content-Length` framing, `initialize`
 * handshake, request correlation, `shutdown`/`exit` — because that is the
 * other half of what `StdioCodeNavigationProvider` is being tested against.
 * A fixture that answered over JSON lines would leave the framing untested,
 * and the framing is where a stdio client actually breaks.
 *
 * `.mjs` and dependency-free at the module level so it can be spawned with
 * plain `node` from a test, with no build step between the two.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const ts = createRequire(import.meta.url)('typescript')

const rootDir = resolve(process.argv[2] ?? process.cwd())

function sourceFiles(dir) {
	const out = []
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules' || entry.startsWith('.')) continue
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
		else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
	}
	return out
}

const files = sourceFiles(rootDir)
const versions = new Map(files.map((f) => [f, 0]))

const service = ts.createLanguageService(
	{
		getScriptFileNames: () => [...versions.keys()],
		getScriptVersion: (f) => String(versions.get(f) ?? 0),
		getScriptSnapshot: (f) => {
			try {
				return ts.ScriptSnapshot.fromString(readFileSync(f, 'utf8'))
			} catch {
				return undefined
			}
		},
		getCurrentDirectory: () => rootDir,
		getCompilationSettings: () => ({
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			strict: true,
			allowJs: false,
		}),
		getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		readDirectory: ts.sys.readDirectory,
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
	},
	ts.createDocumentRegistry(),
)

/** LSP counts lines and characters from zero; the service counts bytes. */
function offsetAt(file, line, character) {
	const text = readFileSync(file, 'utf8')
	const lines = text.split('\n')
	let offset = 0
	for (let i = 0; i < line && i < lines.length; i++) offset += (lines[i]?.length ?? 0) + 1
	return offset + character
}

function toRange(file, start, length) {
	const text = readFileSync(file, 'utf8')
	const before = text.slice(0, start).split('\n')
	const line = before.length - 1
	const character = before[before.length - 1]?.length ?? 0
	const afterStart = text.slice(0, start + length).split('\n')
	return {
		start: { line, character },
		end: { line: afterStart.length - 1, character: afterStart[afterStart.length - 1]?.length ?? 0 },
	}
}

function locate(entries) {
	return (entries ?? []).map((entry) => ({
		uri: pathToFileURL(entry.fileName).href,
		range: toRange(entry.fileName, entry.textSpan.start, entry.textSpan.length),
	}))
}

function handle(message) {
	const { id, method, params } = message
	switch (method) {
		case 'initialize':
			return {
				capabilities: {
					definitionProvider: true,
					referencesProvider: true,
					hoverProvider: true,
					workspaceSymbolProvider: true,
				},
				serverInfo: { name: 'ts-language-service-fixture', version: '0.0.0' },
			}
		case 'textDocument/hover': {
			const file = fileURLToPath(params.textDocument.uri)
			const at = offsetAt(file, params.position.line, params.position.character)
			const info = service.getQuickInfoAtPosition(file, at)
			// `null` when nothing resolves — whitespace, a comment. The provider
			// turns that into empty contents rather than a failure, and this is
			// the shape a real server sends for it.
			if (!info) return null
			const signature = ts.displayPartsToString(info.displayParts ?? [])
			const docs = ts.displayPartsToString(info.documentation ?? [])
			return { contents: docs ? [signature, docs] : [signature] }
		}
		case 'workspace/symbol': {
			// The real index: `getNavigateToItems` is what powers "go to symbol"
			// in an editor, and it returns DECLARATIONS. A comment or a string
			// containing the query is not one, which is the whole difference
			// this operation is asserted on.
			const items = service.getNavigateToItems(params.query ?? '') ?? []
			return items.map((item) => ({
				name: item.name,
				kind: 2,
				...(item.containerName ? { containerName: item.containerName } : {}),
				location: {
					uri: pathToFileURL(item.fileName).href,
					range: toRange(item.fileName, item.textSpan.start, item.textSpan.length),
				},
			}))
		}
		case 'textDocument/definition': {
			const file = fileURLToPath(params.textDocument.uri)
			const at = offsetAt(file, params.position.line, params.position.character)
			return locate(service.getDefinitionAtPosition(file, at))
		}
		case 'textDocument/references': {
			const file = fileURLToPath(params.textDocument.uri)
			const at = offsetAt(file, params.position.line, params.position.character)
			const found = service.getReferencesAtPosition(file, at) ?? []
			// HONOURS the flag rather than always filtering. A fixture that
			// dropped the declaration unconditionally would make the client's
			// `includeDeclaration: false` unobservable — the provider could stop
			// sending it and every test would still pass, which is a fixture
			// unlike production hiding a real regression.
			if (params.context?.includeDeclaration !== false) return locate(found)
			const declaration = (service.getDefinitionAtPosition(file, at) ?? [])[0]
			return locate(
				found.filter(
					(entry) =>
						!declaration ||
						entry.fileName !== declaration.fileName ||
						entry.textSpan.start !== declaration.textSpan.start,
				),
			)
		}
		case 'shutdown':
			return null
		case 'exit':
			process.exit(0)
			return undefined
		default:
			if (id === undefined) return undefined
			throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
	}
}

function send(payload) {
	const body = Buffer.from(JSON.stringify(payload), 'utf8')
	process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
	process.stdout.write(body)
}

let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
	buffer = Buffer.concat([buffer, chunk])
	for (;;) {
		const headerEnd = buffer.indexOf('\r\n\r\n')
		if (headerEnd === -1) return
		const match = /content-length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('utf8'))
		if (!match) {
			buffer = buffer.subarray(headerEnd + 4)
			continue
		}
		const length = Number(match[1])
		const start = headerEnd + 4
		if (buffer.length < start + length) return
		const body = buffer.subarray(start, start + length).toString('utf8')
		buffer = buffer.subarray(start + length)

		let message
		try {
			message = JSON.parse(body)
		} catch {
			continue
		}
		try {
			const result = handle(message)
			if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result })
		} catch (err) {
			if (message.id !== undefined) {
				send({
					jsonrpc: '2.0',
					id: message.id,
					error: { code: err.code ?? -32603, message: err.message },
				})
			}
		}
	}
})
