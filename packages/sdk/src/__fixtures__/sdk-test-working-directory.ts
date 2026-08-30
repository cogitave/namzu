import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'
import { isMainThread } from 'node:worker_threads'

const TEST_ROOT_PREFIX = 'namzu-sdk-tests-'
const TEST_ROOT_ENV = 'NAMZU_SDK_TEST_ROOT'
const WORKER_VERIFIED_ENV = 'NAMZU_SDK_TEST_WORKER_VERIFIED'

if (!isMainThread) {
	throw new Error('SDK tests require the configured fork pool; a thread cannot own process.cwd().')
}

const suppliedRoot = process.env[TEST_ROOT_ENV]
if (!suppliedRoot) {
	throw new Error('SDK tests require scripts/run-sdk-tests.mjs to own their working directory.')
}

const [workingDirectory, temporaryRoot, actualWorkingDirectory] = await Promise.all([
	realpath(suppliedRoot),
	realpath(tmpdir()),
	realpath(process.cwd()),
])
const name = basename(workingDirectory)
const suffix = name.slice(TEST_ROOT_PREFIX.length)

if (
	dirname(workingDirectory) !== temporaryRoot ||
	!name.startsWith(TEST_ROOT_PREFIX) ||
	suffix.length < 6 ||
	suffix.includes('/') ||
	suffix.includes('\\')
) {
	throw new Error(
		`SDK test working directory is outside its temporary authority: ${workingDirectory}`,
	)
}
if (actualWorkingDirectory !== workingDirectory) {
	throw new Error(
		`SDK test worker inherited ${actualWorkingDirectory}; expected the owned root ${workingDirectory}.`,
	)
}

// The focused process observer checks this exact worker-local publication. The
// runner deliberately strips an inherited value before it starts Vitest, so a
// missing setup file cannot pass on a marker from its parent test process.
process.env[WORKER_VERIFIED_ENV] = workingDirectory
