import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

// Native Windows, isolated built consumer only. No live desktop, Pal,
// credentials, computer provider, installation or real model is used.
assert.equal(process.platform, 'win32')
assert.ok(process.argv[2], 'Supply the isolated staged snapshot path.')
const snapshot = realpathSync(resolve(process.argv[2]))
const temp = realpathSync(join(process.env.LOCALAPPDATA, 'Temp'))
assert.ok(snapshot.startsWith(`${temp}${sep}`))
assert.ok(basename(snapshot).startsWith('namzu-native-consumer-presence-tool-retry-20261006'))
assert.ok(!snapshot.toLowerCase().includes(`${sep}development${sep}runtime`))
const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8'))
assert.equal(manifest.v, 1)
const cliEntry = join(snapshot, manifest.cli)
const sdkPackage = manifest.packages.find(item => item.name === '@namzu/sdk')
assert.ok(sdkPackage)
const sdkRoot = realpathSync(join(snapshot, sdkPackage.relative))
const requireCli = createRequire(cliEntry)
const sdkEntry = realpathSync(requireCli.resolve('@namzu/sdk'))
assert.equal(sdkEntry, realpathSync(join(sdkRoot, 'dist/index.js')))

let verifiedLinks = 0
let sdkUsers = 0
for (const item of manifest.packages) {
	for (const [name, target] of Object.entries(item.links)) {
		const actual = realpathSync(join(snapshot, item.relative, 'node_modules', name))
		assert.equal(actual, realpathSync(join(snapshot, target)))
		assert.ok(actual.startsWith(`${snapshot}${sep}`))
		verifiedLinks++
	}
	if (item.links['@namzu/sdk']) {
		const from = createRequire(join(snapshot, item.relative, 'package.json'))
		assert.equal(realpathSync(from.resolve('@namzu/sdk')), sdkEntry)
		sdkUsers++
	}
}
const requireSdk = createRequire(join(sdkRoot, 'package.json'))
const zodEntry = realpathSync(requireSdk.resolve('zod'))
assert.ok(zodEntry.startsWith(`${snapshot}${sep}`))
let networkCalls = 0
globalThis.fetch = async () => {
	networkCalls++
	throw new Error('Network is forbidden in this isolated mock probe.')
}

const isolatedHome = join(snapshot, 'probe-home')
assert.ok(!existsSync(isolatedHome), 'Use a fresh snapshot for the first probe.')
const help = spawnSync(process.execPath, [cliEntry, '--help'], {
	cwd: snapshot,
	encoding: 'utf8',
	windowsHide: true,
	env: { ...process.env, NAMZU_HOME: isolatedHome },
})
assert.ifError(help.error)
assert.equal(help.status, 0, help.stderr)
assert.ok(/Usage: namzu/.test(help.stdout))
process.env.NAMZU_HOME = isolatedHome

const { drainQuery, MockLLMProvider, createUserMessage, generateTurnId } = await import(pathToFileURL(sdkEntry).href)
const { z } = await import(pathToFileURL(zodEntry).href)
const { InMemorySessionLog } = await import(pathToFileURL(join(sdkRoot, 'dist/store/session-log/index.js')).href)
const { resolveSessionStorage } = await import(pathToFileURL(join(sdkRoot, 'dist/runtime/query/session-storage.js')).href)
const sessionId = randomUUID()
const turnId = generateTurnId()
const scope = { tenantId: randomUUID(), projectId: randomUUID(), topicId: randomUUID(), sessionId }
const sessionLog = new InMemorySessionLog({ sessionId })
const provider = new MockLLMProvider({
	turns: [{ toolCalls: [{ name: 'structured_output', args: { score: 'invalid-score' } }] }],
})
const run = await drainQuery({
	...scope,
	sessionLog,
	provider,
	toolsets: [],
	agentId: 'isolated-native-structured-retries',
	agentName: 'Isolated native structured retries',
	messages: [createUserMessage('Return a score')],
	workingDirectory: snapshot,
	turnId,
	turnConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 10_000, maxIterations: 12 },
	structuredOutput: { schema: z.object({ score: z.number() }), maxRetries: 0 },
})
assert.equal(provider.requests.length, 1)
assert.equal(run.stopReason, 'structured_output_failed')
assert.equal(run.structuredOutput, undefined)
const storage = await resolveSessionStorage({ sessionId, sessionLog })
const checkpoints = await storage.checkpoints.list({ tenantId: scope.tenantId, projectId: scope.projectId, sessionId, turnId })
const checkpoint = checkpoints.at(-1)
assert.ok(checkpoint)
assert.equal(checkpoint.review.toolStructuredAttempts, 1)
assert.equal(checkpoint.review.structuredAttempts, 0)
assert.equal(checkpoint.review.nativeStructuredAttempts, 0)
const entries = (await sessionLog.readAll()).entries
const completed = entries.map(entry => entry.record).filter(record => record.type === 'tool_completed')
assert.equal(completed.length, 1)
assert.equal(completed[0].isError, true)
assert.equal(completed[0].inputFailure, 'schema_validation')
assert.equal(networkCalls, 0)

const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const productionFiles = [
	['sdk/pals/prompt', join(sdkRoot, 'dist/pals/prompt.js')],
	['sdk/query/index', join(sdkRoot, 'dist/runtime/query/index.js')],
	['sdk/query/iteration', join(sdkRoot, 'dist/runtime/query/iteration/index.js')],
	['cli/pals/agent-session', join(snapshot, 'packages/p0/dist/pals/agent-session.js')],
]
const receipt = {
	version: 1,
	result: 'passed',
	verifiedAt: new Date().toISOString(),
	platform: process.platform,
	arch: process.arch,
	node: process.version,
	scope: 'Fresh isolated native Windows built consumer graph and real query loop with mock inference only; not live deployment.',
	snapshot,
	manifestSha256: hashFile(join(snapshot, 'manifest.json')),
	packageCount: manifest.packages.length,
	copiedWorkspacePackages: manifest.copiedWorkspacePackages,
	verifiedLinks,
	sdkUsers,
	singleSdkRoot: true,
	sdkEntry,
	zodEntry,
	cliHelp: { exitCode: help.status, usagePresent: true, isolatedNamzuHome: isolatedHome },
	structuredOutputProbe: {
		mode: 'tool',
		provider: 'MockLLMProvider',
		maxRetries: 0,
		requests: provider.requests.length,
		stopReason: run.stopReason,
		structuredValuePublished: run.structuredOutput !== undefined,
		checkpoints: checkpoints.length,
		review: checkpoint.review,
		toolResults: completed.length,
		toolResultIsError: completed[0].isError,
		toolInputFailure: completed[0].inputFailure,
	},
	productionFiles: productionFiles.map(([label, file]) => ({ label, relative: file.slice(snapshot.length + 1), sha256: hashFile(file) })),
	modelRequestsToRealProviders: 0,
	networkCalls,
	packageInstallCalls: 0,
	activeRuntimeFilesChanged: 0,
	launchConfigurationChanged: false,
	livePalActions: 0,
	liveProcessRestartsOrCloses: 0,
}
const serialized = `${JSON.stringify(receipt, null, 2)}\n`
if (process.argv[3]) writeFileSync(resolve(process.argv[3]), serialized, { encoding: 'utf8', flag: 'wx' })
process.stdout.write(serialized)
