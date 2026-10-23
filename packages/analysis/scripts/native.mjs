#!/usr/bin/env node
/**
 * Runs the Rust half of this package: `build`, `test` or `lint`.
 *
 *   node scripts/native.mjs build   cargo build --release
 *   node scripts/native.mjs test    cargo test
 *   node scripts/native.mjs lint    cargo fmt --check, clippy -D warnings, licences
 *
 * Why a wrapper and not `cargo` in package.json:
 *
 * - The shell may export `CARGO_TARGET_DIR` for some other project. Building
 *   into it would write into that project's tree, so the target directory is
 *   always set here, to `packages/analysis/target` (gitignored).
 * - `pnpm -r build` runs this package with every other one. A contributor with
 *   no Rust toolchain should still be able to build the TypeScript packages, so
 *   without `cargo` the step is skipped with a loud line, but only when `CI` is
 *   unset. In CI a missing toolchain fails the step: a skipped native build
 *   there would let the TypeScript tests pass against no binary.
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const crate = join(root, 'native')
const mode = process.argv[2]

if (!['build', 'test', 'lint'].includes(mode ?? '')) {
	console.error('usage: native.mjs <build|test|lint>')
	process.exit(2)
}

const env = { ...process.env, CARGO_TARGET_DIR: join(root, 'target') }

const probe = spawnSync('cargo', ['--version'], { env, encoding: 'utf8' })
if (probe.error || probe.status !== 0) {
	const why = `[analysis] \`cargo\` is not available, so the native ${mode} step`
	if (process.env.CI) {
		console.error(`${why} cannot run, and CI requires it. Install a Rust toolchain.`)
		process.exit(1)
	}
	console.warn(`${why} is SKIPPED (CI unset). Install Rust (https://rustup.rs) to run it.`)
	process.exit(0)
}

function run(command, args, options = {}) {
	console.log(`$ ${command} ${args.join(' ')}`)
	const r = spawnSync(command, args, { cwd: crate, env, stdio: 'inherit', ...options })
	if (r.error) {
		console.error(r.error.message)
		process.exit(1)
	}
	if (r.status !== 0) process.exit(r.status ?? 1)
}

if (mode === 'build') {
	run('cargo', ['build', '--release', '--locked'])
} else if (mode === 'test') {
	run('cargo', ['test', '--locked'])
} else {
	run('cargo', ['fmt', '--check'])
	run('cargo', ['clippy', '--locked', '--all-targets', '--', '-D', 'warnings'])
	run('node', [join(root, 'scripts', 'check-licenses.mjs')], { cwd: root })
}
