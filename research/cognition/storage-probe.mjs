/** Bounded scan-versus-index payload experiment; not a replacement memory store. */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { DiskMemoryStore } from '../../packages/sdk/dist/index.js'
// Internal diagnostic seam, deliberately confined to this executable/process.
import { DiskRecordStore } from '../../packages/sdk/dist/store/kv/record-store.js'

assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Run this experiment with Node 24')
const QUERY = 'ceruleanexpiry'
const UPDATED_QUERY = 'violetexpiry'
const BODY_BYTES = 4096
const K = 3
const SCOPES = ['selected', 'unrelated']
const COUNTS = [128, 64]
const WARMUPS = 3
const SAMPLES = 20
const root = await mkdtemp(join(tmpdir(), 'namzu-storage-probe-'))
const originalRead = DiskRecordStore.prototype.read
const originalFetch = globalThis.fetch
const quiet = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	child() {
		return this
	},
}
let database
let activeReadCounter

function body(index, marker) {
	const prefix = `Record ${index}. ${marker ?? 'ordinaryfacts'} describes the local fixture. `
	return (prefix + 'alpha beta gamma delta epsilon '.repeat(160)).slice(0, BODY_BYTES)
}

async function fileBytes(path) {
	const info = await stat(path)
	if (!info.isDirectory()) return info.size
	let total = 0
	for (const name of await readdir(path)) total += await fileBytes(join(path, name))
	return total
}

async function measured(operation) {
	const cpu = process.cpuUsage()
	const start = performance.now()
	const value = await operation()
	const used = process.cpuUsage(cpu)
	return {
		value,
		elapsedMs: performance.now() - start,
		processCpuMs: (used.user + used.system) / 1000,
	}
}

globalThis.fetch = () => {
	throw new Error('Network forbidden in the storage probe')
}
DiskRecordStore.prototype.read = async function (path, ...args) {
	const value = await originalRead.call(this, path, ...args)
	if (activeReadCounter && path.startsWith(`${root}${sep}`)) {
		if (path.includes(`${sep}memory${sep}content${sep}`)) {
			assert.equal(typeof value?.content, 'string')
			activeReadCounter.bodyReadCalls += 1
			activeReadCounter.decodedBodyBytes += Buffer.byteLength(value.content)
		} else if (path.endsWith(`${sep}memory${sep}index.json`)) {
			activeReadCounter.indexReadCalls += 1
		}
	}
	return value
}

try {
	const stores = SCOPES.map(
		(scope) => new DiskMemoryStore({ baseDir: join(root, 'disk', scope), logger: quiet }),
	)
	const records = []
	const diskSeed = await measured(async () => {
		for (const [scopeIndex, scope] of SCOPES.entries()) {
			for (let index = 0; index < COUNTS[scopeIndex]; index++) {
				// Every unrelated record matches: scope filtering must precede top-k.
				const content = body(index, scopeIndex === 1 || index < K ? QUERY : undefined)
				assert.equal(Buffer.byteLength(content), BODY_BYTES)
				const params = { title: `Note ${index}`, summary: 'Synthetic storage fixture', content }
				const saved = await stores[scopeIndex].create(params)
				records.push({ id: saved.entry.id, scope, ...params })
			}
		}
	})

	database = new DatabaseSync(join(root, 'indexed.sqlite'))
	database.exec(`
    PRAGMA journal_mode=DELETE;
    PRAGMA synchronous=FULL;
    CREATE TABLE records (rowid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL,
      scope TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL);
    CREATE INDEX scoped_records ON records(scope, status);
    CREATE TABLE payload (rowid INTEGER PRIMARY KEY REFERENCES records(rowid), body TEXT NOT NULL);
    CREATE VIRTUAL TABLE search USING fts5(title, summary, body, content='');
  `)
	const insertRecord = database.prepare(
		'INSERT INTO records(id,scope,status,title,summary) VALUES(?,?,?,?,?)',
	)
	const insertPayload = database.prepare('INSERT INTO payload(rowid,body) VALUES(?,?)')
	const insertIndex = database.prepare(
		'INSERT INTO search(rowid,title,summary,body) VALUES(?,?,?,?)',
	)
	const deleteIndex = database.prepare(
		"INSERT INTO search(search,rowid,title,summary,body) VALUES('delete',?,?,?,?)",
	)
	function transaction(operation) {
		database.exec('BEGIN')
		try {
			const result = operation()
			database.exec('COMMIT')
			return result
		} catch (error) {
			database.exec('ROLLBACK')
			throw error
		}
	}
	const sqliteSeed = await measured(() => {
		for (const record of records)
			transaction(() => {
				const result = insertRecord.run(
					record.id,
					record.scope,
					'active',
					record.title,
					record.summary,
				)
				record.rowid = Number(result.lastInsertRowid)
				insertPayload.run(record.rowid, record.content)
			})
	})
	const sqliteIndex = await measured(() =>
		transaction(() => {
			for (const record of records)
				insertIndex.run(record.rowid, record.title, record.summary, record.content)
		}),
	)
	const candidateQuery = database.prepare(`
    SELECT records.rowid, records.id FROM search
    JOIN records ON records.rowid=search.rowid
    WHERE search MATCH ? AND records.scope=? AND records.status='active'
    ORDER BY bm25(search,8,4,1), records.id LIMIT ?
  `)
	const payloadQuery = database.prepare('SELECT body FROM payload WHERE rowid=?')
	function indexedQuery(scope = SCOPES[0], query = QUERY) {
		return transaction(() => {
			const candidates = candidateQuery.all(query, scope, K)
			let decodedBodyBytes = 0
			for (const candidate of candidates) {
				const content = payloadQuery.get(candidate.rowid).body
				decodedBodyBytes += Buffer.byteLength(content)
				assert.ok(content.includes(query))
			}
			return {
				ids: candidates.map((item) => item.id),
				bodyReadCalls: candidates.length,
				decodedBodyBytes,
			}
		})
	}
	async function diskQuery(scopeIndex = 0, query = QUERY) {
		const counts = { bodyReadCalls: 0, decodedBodyBytes: 0, indexReadCalls: 0 }
		assert.equal(activeReadCounter, undefined)
		activeReadCounter = counts
		try {
			const result = await stores[scopeIndex].list({ query, status: 'active', limit: K })
			const searchBodyReadCalls = counts.bodyReadCalls
			const searchBodyBytes = counts.decodedBodyBytes
			for (const entry of result.entries) {
				const record = await stores[scopeIndex].getRecord(entry.id)
				assert.equal(record.entry.status, 'active')
				assert.ok(record.content.content.includes(query))
			}
			return {
				ids: result.entries.map((entry) => entry.id),
				...counts,
				searchBodyReadCalls,
				searchBodyBytes,
				selectedPayloadReadCalls: counts.bodyReadCalls - searchBodyReadCalls,
			}
		} finally {
			activeReadCounter = undefined
		}
	}
	const selected = records.filter((record) => record.scope === SCOPES[0]).slice(0, K)
	function assertIds(result, expected) {
		assert.deepEqual([...result.ids].sort(), expected.map((record) => record.id).sort())
	}
	assertIds(await diskQuery(), selected)
	assertIds(indexedQuery(), selected)
	for (const result of [await diskQuery(1), indexedQuery(SCOPES[1])]) {
		assert.equal(result.ids.length, K)
		assert.ok(
			result.ids.every((id) =>
				records.some((record) => record.id === id && record.scope === SCOPES[1]),
			),
		)
	}

	const updatePayload = database.prepare('UPDATE payload SET body=? WHERE rowid=?')
	const updateStatus = database.prepare('UPDATE records SET status=? WHERE rowid=?')
	async function update(record, content) {
		await stores[0].update(record.id, { content })
		transaction(() => {
			const previous = payloadQuery.get(record.rowid).body
			deleteIndex.run(record.rowid, record.title, record.summary, previous)
			updatePayload.run(content, record.rowid)
			insertIndex.run(record.rowid, record.title, record.summary, content)
		})
	}
	await update(selected[0], body(0, UPDATED_QUERY))
	assertIds(await diskQuery(), selected.slice(1))
	assertIds(indexedQuery(), selected.slice(1))
	assertIds(await diskQuery(0, UPDATED_QUERY), [selected[0]])
	assertIds(indexedQuery(SCOPES[0], UPDATED_QUERY), [selected[0]])
	await update(selected[0], selected[0].content)
	await stores[0].update(selected[2].id, { status: 'archived' })
	transaction(() => updateStatus.run('archived', selected[2].rowid))
	assertIds(await diskQuery(), selected.slice(0, 2))
	assertIds(indexedQuery(), selected.slice(0, 2))
	await stores[0].update(selected[2].id, { status: 'active' })
	transaction(() => updateStatus.run('active', selected[2].rowid))
	assertIds(await diskQuery(), selected)
	assertIds(indexedQuery(), selected)

	for (let i = 0; i < WARMUPS; i++) {
		await diskQuery()
		indexedQuery()
	}
	const samples = { disk: [], sqlite: [] }
	const processCpuMs = { disk: 0, sqlite: 0 }
	const reads = {}
	// Alternate order to avoid always measuring one implementation first.
	for (let i = 0; i < SAMPLES; i++) {
		for (const kind of i % 2 ? ['sqlite', 'disk'] : ['disk', 'sqlite']) {
			const result = await measured(kind === 'disk' ? diskQuery : indexedQuery)
			assertIds(result.value, selected)
			samples[kind].push(result.elapsedMs)
			processCpuMs[kind] += result.processCpuMs
			const { ids, ...counts } = result.value
			if (reads[kind]) assert.deepEqual(counts, reads[kind])
			reads[kind] = counts
		}
	}
	assert.equal(reads.disk.searchBodyReadCalls, COUNTS[0])
	assert.equal(reads.disk.bodyReadCalls, COUNTS[0] + K)
	assert.equal(reads.disk.decodedBodyBytes, (COUNTS[0] + K) * BODY_BYTES)
	assert.equal(reads.sqlite.bodyReadCalls, K)
	assert.equal(reads.sqlite.decodedBodyBytes, K * BODY_BYTES)
	function summary(kind) {
		const sorted = [...samples[kind]].sort((a, b) => a - b)
		return {
			p50Ms: sorted[Math.ceil(SAMPLES * 0.5) - 1],
			p95Ms: sorted[Math.ceil(SAMPLES * 0.95) - 1],
			measuredBatchProcessCpuMs: processCpuMs[kind],
			perQuery: reads[kind],
		}
	}
	const { value: _disk, ...diskSeeding } = diskSeed
	const { value: _sqlite, ...sqliteSeeding } = sqliteSeed
	const { value: _index, ...sqliteIndexing } = sqliteIndex
	const report = {
		kind: 'bounded-scoped-payload-materialization',
		node: process.version,
		sqlite: database.prepare('SELECT sqlite_version() version').get().version,
		nodeSqliteStatus:
			'Node 24 built-in used by this research-only experiment; not a production dependency proposal',
		platform: process.platform,
		architecture: process.arch,
		cpu: cpus()[0]?.model,
		fixture: {
			selectedScopeRecords: COUNTS[0],
			unrelatedScopeRecords: COUNTS[1],
			bodyBytes: BODY_BYTES,
			query: QUERY,
			selectedMatches: K,
			unrelatedMatches: COUNTS[1],
			resultLimit: K,
		},
		queries: {
			warmupsPerImplementation: WARMUPS,
			measuredPerImplementation: SAMPLES,
			includes:
				'Candidate selection, active/scope filtering, and selected body retrieval with diagnostic counters',
		},
		disk: {
			...summary('disk'),
			seedingIncludingIndex: diskSeeding,
			storageLogicalFileBytes: await fileBytes(join(root, 'disk')),
		},
		sqliteFts5: {
			...summary('sqlite'),
			payloadAndMetadataSeeding: sqliteSeeding,
			indexConstruction: sqliteIndexing,
			storageLogicalFileBytes: await fileBytes(join(root, 'indexed.sqlite')),
			journalMode: 'delete',
			synchronous: 'full',
			indexKind: 'Contentless FTS5 plus separate metadata/payload tables',
		},
		assertions: {
			sameSelectedIds: true,
			scopeBeforeLimitWithManyForeignMatches: true,
			oldTermRemovedAfterUpdate: true,
			newTermVisibleAfterUpdate: true,
			archivedExcluded: true,
			reactivatedVisible: true,
			diagnosticCountsStableAcrossSamples: true,
		},
		processPeakRssKiB: process.resourceUsage().maxRSS,
		externalModelCalls: 0,
		limitations: [
			'Warm local temporary-filesystem experiment; no cache eviction, physical medium identification, cold-disk or HDD performance measurement.',
			'Decoded body bytes/calls are application-level materialization, not physical I/O. Disk metadata-index calls are reported separately; lock I/O is uncounted. SQLite engine page/index reads are unmeasured.',
			'DiskMemoryStore uses per-operation locks, validation and JSON metadata reloads. SQLite uses synchronous SQL transactions; this is not an equivalent production implementation or a speed-ratio claim.',
			'The selective single ASCII token has equal matching IDs here; Unicode tokenization, multiword semantics, BM25 and SDK lexical ranking differ. FTS5 is not a drop-in search replacement.',
			'Disk seeding includes index rewrites per create. SQLite record seeding uses one transaction per record and index construction one batch transaction; write costs have different semantics.',
			'CPU deltas and peak RSS describe this shared Node process, including both implementations, SDK imports, fixture data and diagnostics; neither isolates store memory or system I/O cost.',
			'Logical file sizes include both scopes and retained SQLite pages after freshness tests; they are not allocated disk blocks. No concurrent-writer, crash-recovery, query-planner stability or production-scale claim.',
		],
	}
	if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(report, null, 2)}\n`)
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally {
	DiskRecordStore.prototype.read = originalRead
	globalThis.fetch = originalFetch
	try {
		database?.close()
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}
