import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const installer = fileURLToPath(new URL('../../install.sh', import.meta.url))
const skip = process.platform === 'win32' ? 'POSIX installer requires a POSIX shell' : false

// Run the shipped installer with private executable fixtures. No real npm,
// package installation, profile change or user-owned directory is reached.
function runInstaller({
	globalExit = 0,
	prefixExit = 0,
	versionExit = 0,
	emptyVersion = false,
	nodeVersion = 'v22.13.0',
	shell = '/bin/bash',
	optOut = false,
	runs = 1,
	prepare = () => {},
} = {}) {
	const directory = mkdtempSync(join(tmpdir(), 'namzu-installer-test-'))
	const bin = join(directory, 'bin')
	const calls = join(directory, 'npm-calls')
	const versionBinary = join(directory, 'mock-namzu')
	mkdirSync(bin)
	const home = join(directory, 'home')
	mkdirSync(home)
	prepare(home)
	const executable = (path, source) => {
		writeFileSync(path, source)
		chmodSync(path, 0o700)
	}
	executable(join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$NAMZU_TEST_NODE_VERSION"\n')
	executable(
		versionBinary,
		'#!/bin/sh\n[ "$NAMZU_TEST_EMPTY_VERSION" = true ] || printf "test-version\\n"\n[ "$NAMZU_TEST_VERSION_EXIT" -eq 0 ] || printf "version-stderr-fixture\\n" >&2\nexit "$NAMZU_TEST_VERSION_EXIT"\n',
	)
	executable(
		join(bin, 'npm'),
		`#!/bin/sh
printf '%s\\n' "$*" >> "$NAMZU_TEST_CALLS"
[ "$1" = install ] || exit 99
phase=global
target="$NAMZU_TEST_BIN"
status="$NAMZU_TEST_GLOBAL_EXIT"
while [ "$#" -gt 0 ]; do
  if [ "$1" = --prefix ]; then
    shift
    phase=prefix
    target="$1/bin"
    status="$NAMZU_TEST_PREFIX_EXIT"
  fi
  shift
done
printf 'npm-%s-stdout-fixture\\n' "$phase"
printf 'npm-%s-stderr-fixture\\n' "$phase" >&2
if [ "$status" -eq 0 ]; then
  mkdir -p "$target"
  cp "$NAMZU_TEST_VERSION_BINARY" "$target/namzu"
  chmod 700 "$target/namzu"
fi
exit "$status"
`,
	)
	try {
		const options = {
			encoding: 'utf8',
			// This bounds a real shell subprocess, not an assertion about host speed.
			timeout: 30_000,
			env: {
				...process.env,
				HOME: home,
				SHELL: shell,
				ZDOTDIR: '',
				NAMZU_NO_MODIFY_PATH: optOut ? '1' : '',
				PATH: `${bin}:${process.env.PATH}`,
				NAMZU_VERSION: 'latest',
				NAMZU_PREFIX: join(directory, 'fallback prefix'),
				NAMZU_TEST_BIN: bin,
				NAMZU_TEST_CALLS: calls,
				NAMZU_TEST_VERSION_BINARY: versionBinary,
				NAMZU_TEST_GLOBAL_EXIT: String(globalExit),
				NAMZU_TEST_PREFIX_EXIT: String(prefixExit),
				NAMZU_TEST_VERSION_EXIT: String(versionExit),
				NAMZU_TEST_EMPTY_VERSION: String(emptyVersion),
				NAMZU_TEST_NODE_VERSION: nodeVersion,
			},
		}
		let result
		for (let i = 0; i < runs; i++) result = spawnSync('sh', [installer], options)
		assert.equal(result.error?.message, undefined, `stdout: ${result.stdout}; stderr: ${result.stderr}`)
		// Snapshot now: the directory is removed when this function returns.
		const files = {}
		for (const name of ['.bashrc', '.bash_profile', '.zshrc', '.profile', '.config/fish/conf.d/namzu.fish']) {
			try {
				files[name] = readFileSync(join(home, name), 'utf8')
			} catch {
				files[name] = null
			}
		}
		return { ...result, calls: readCalls(), read: (name) => files[name] ?? null }
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
	function readCalls() {
		try {
			return readFileSync(calls, 'utf8').trim().split('\n')
		} catch {
			return []
		}
	}
}

test('POSIX installer verifies successful global installation without install chatter', { skip }, () => {
	const result = runInstaller()
	assert.equal(result.status, 0, result.stderr)
	assert.equal(result.calls.length, 1)
	assert.match(result.calls[0], /^install --global .*@namzu\/cli@latest$/)
	assert.match(result.stdout, /namzu test-version installed/)
	assert.doesNotMatch(`${result.stdout}${result.stderr}`, /npm-global-(stdout|stderr)-fixture/)
})

test('POSIX installer says one plain line, not npm output, when its fallback succeeds', { skip }, () => {
	const result = runInstaller({ globalExit: 13 })
	assert.equal(result.status, 0, result.stderr)
	assert.equal(result.calls.length, 2)
	assert.match(result.calls[1], /--prefix .*fallback prefix/)
	assert.match(result.stdout, /global npm folder is not writable, installing into .*fallback prefix/)
	assert.doesNotMatch(`${result.stdout}${result.stderr}`, /npm-(global|prefix)-(stdout|stderr)-fixture/)
	assert.match(result.stdout, /namzu test-version installed/)
})

test('POSIX installer puts a fallback install on PATH once, in the login shell profile', { skip }, () => {
	const result = runInstaller({ globalExit: 13, runs: 2 })
	assert.equal(result.status, 0, result.stderr)
	const rc = result.read('.bashrc')
	assert.match(rc, /# >>> namzu >>>\nexport PATH="[^"]*fallback prefix\/bin:\$PATH"\n# <<< namzu <<</)
	assert.equal(rc.split('>>> namzu >>>').length, 2, 'block must not be duplicated')
	assert.equal(result.read('.bash_profile'), null)
	assert.match(result.stdout, /already puts it on PATH/)
	assert.match(result.stdout, /export PATH="[^"]*fallback prefix\/bin:\$PATH"/)
})

test('POSIX installer writes the profile its shell reads', { skip }, () => {
	const fish = runInstaller({ globalExit: 13, shell: '/usr/bin/fish' })
	assert.match(fish.read('.config/fish/conf.d/namzu.fish'), /set -gx PATH ".*fallback prefix\/bin" \$PATH/)
	const zsh = runInstaller({ globalExit: 13, shell: '/bin/zsh' })
	assert.match(zsh.read('.zshrc'), /export PATH=/)
	const other = runInstaller({ globalExit: 13, shell: '/bin/dash' })
	assert.match(other.read('.profile'), /export PATH=/)
	const both = runInstaller({
		globalExit: 13,
		prepare: (home) => writeFileSync(join(home, '.bash_profile'), '# mine\n'),
	})
	assert.match(both.read('.bash_profile'), /# mine\n[\s\S]*>>> namzu >>>/)
	assert.match(both.read('.bashrc'), />>> namzu >>>/)
})

test('POSIX installer leaves profiles alone with NAMZU_NO_MODIFY_PATH=1 or a global install', { skip }, () => {
	const optOut = runInstaller({ globalExit: 13, optOut: true })
	assert.equal(optOut.read('.bashrc'), null)
	assert.match(optOut.stdout, /no shell profile was changed/)
	const global = runInstaller()
	assert.equal(global.read('.bashrc'), null)
})

test('POSIX installer preserves both failed npm attempts and refuses success', { skip }, () => {
	const result = runInstaller({ globalExit: 13, prefixExit: 42 })
	assert.equal(result.status, 1, result.stderr)
	assert.equal(result.calls.length, 2)
	for (const phase of ['global', 'prefix']) {
		assert.match(result.stderr, new RegExp(`npm-${phase}-stdout-fixture`))
		assert.match(result.stderr, new RegExp(`npm-${phase}-stderr-fixture`))
	}
	assert.match(result.stderr, /install failed both globally/)
	assert.doesNotMatch(result.stdout, /test-version installed/)
})

test('POSIX installer refuses failed version verification even with stdout', { skip }, () => {
	const result = runInstaller({ versionExit: 7 })
	assert.equal(result.status, 1, result.stderr)
	assert.match(result.stderr, /did not answer --version/)
	assert.match(result.stderr, /version-stderr-fixture/)
	assert.doesNotMatch(result.stdout, /test-version installed/)
})

test('POSIX installer refuses an empty successful version answer', { skip }, () => {
	const result = runInstaller({ emptyVersion: true })
	assert.equal(result.status, 1, result.stderr)
	assert.match(result.stderr, /did not answer --version/)
	assert.doesNotMatch(result.stdout, /test-version installed/)
})

test('POSIX installer rejects a Node runtime below the minimum before npm', { skip }, () => {
	const result = runInstaller({ nodeVersion: 'v22.12.9' })
	assert.equal(result.status, 1, result.stderr)
	assert.deepEqual(result.calls, [])
	assert.match(result.stderr, /namzu needs Node 22\.13 or newer/)
})

test('POSIX installer says where to get Node when it is too old', { skip }, () => {
	const result = runInstaller({ nodeVersion: 'v20.0.0' })
	assert.match(result.stderr, /https:\/\/nodejs\.org/)
	assert.match(result.stderr, /nvm install 22/)
})
