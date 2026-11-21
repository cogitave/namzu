#!/usr/bin/env node
/**
 * Release by hand, when GitHub Actions cannot run.
 *
 *   pnpm release version                      run `changeset version`, show the bumps, stop for a PR
 *   pnpm release local [--dry-run]            publish the npm packages (what release.yml's publish does)
 *   pnpm release record-gates --summary <f>   write the local gate record for this tree
 *   pnpm release desktop  --pal-computer-image <f> --pal-computer-manifest <f>
 *   pnpm release desktop publish --installer <dir> [--dry-run]
 *
 * It runs the same checks the workflows run and refuses on the first that fails. It never
 * unpublishes, never publishes a version the registry already has, and never signs in for you.
 * Everything that touches the network or the machine goes through the injected `deps`, so the
 * decision logic is tested without npm, gh or a registry (scripts/__tests__/release.test.mjs).
 * Read docs/cli/releasing.md before the first real run.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decidePending } from '../.github/scripts/pending-changesets.mjs'

export const FEED_TAG = 'desktop-latest'
export const ELECTRON_BUILDER_VERSION = '26.17.0'
export const GATE_DIR = '.release/gates'
export const VERIFY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000]

export class Refusal extends Error {}

const fail = (message) => {
	throw new Refusal(message)
}

/** Split `argv` into a command, positional words and flags. */
export function parseArgs(argv) {
	const words = []
	const flags = {}
	const valued = new Set([
		'gates',
		'otp',
		'summary',
		'installer',
		'version',
		'out',
		'pal-computer-image',
		'pal-computer-manifest',
	])
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (!a.startsWith('--')) {
			words.push(a)
			continue
		}
		const key = a.slice(2)
		if (valued.has(key)) {
			if (argv[i + 1] === undefined) fail(`--${key} needs a value`)
			flags[key] = argv[++i]
		} else flags[key] = true
	}
	return { words, flags, dryRun: flags['dry-run'] === true }
}

// ---- shared checks ---------------------------------------------------------------------------

function must(deps, cmd, args, what, opts) {
	const r = deps.run(cmd, args, opts)
	if (r.status !== 0) fail(`${what} failed (${cmd} ${args.join(' ')}): ${(r.stderr || r.stdout || '').trim()}`)
	return r.stdout ?? ''
}

/** HEAD is origin/main and the working tree is clean. Returns { head, tree }. */
export function requireCleanMain(deps) {
	const status = must(deps, 'git', ['status', '--porcelain'], 'reading the working tree')
	if (status.trim() !== '') fail('the working tree is not clean; commit or remove the changes first.')
	must(deps, 'git', ['fetch', 'origin', 'main'], 'fetching origin/main')
	const head = must(deps, 'git', ['rev-parse', 'HEAD'], 'reading HEAD').trim()
	const main = must(deps, 'git', ['rev-parse', 'origin/main'], 'reading origin/main').trim()
	if (head !== main) fail(`HEAD (${head.slice(0, 9)}) is not origin/main (${main.slice(0, 9)}); release from main only.`)
	const tree = must(deps, 'git', ['rev-parse', 'HEAD^{tree}'], 'reading the tree').trim()
	return { head, tree }
}

/** Refuses while any changeset is pending in HEAD. */
export function requireNoPendingChangesets(deps) {
	const out = must(deps, 'git', ['ls-tree', '-z', 'HEAD^{tree}', '.changeset/'], 'listing .changeset')
	const { pending, reason } = decidePending(out)
	if (pending.length > 0) {
		fail(
			`${pending.length} changeset(s) are pending (${pending.join(', ')}). A release publishes only a tree with none:\n` +
				'  run `pnpm release version`, open the version PR, merge it, then run `pnpm release local` again.',
		)
	}
	if (reason !== 'no pending changeset') fail(`cannot establish that no changeset is pending: ${reason}`)
}

/** A gate proof is text with `tree <sha>` and `DONE fail=0`, and no non-zero `fail=`. */
export function parseGateProof(text, tree) {
	if (typeof text !== 'string') return { ok: false, reason: 'no proof text' }
	const trees = [...text.matchAll(/^tree[: ]\s*([0-9a-f]{40,64})\s*$/gm)].map((m) => m[1])
	if (!trees.includes(tree)) return { ok: false, reason: `it does not name this tree (${tree.slice(0, 12)})` }
	if (/fail=(?!0\b)\d+/.test(text)) return { ok: false, reason: 'it reports failures' }
	if (!/\bDONE\s+fail=0\b/.test(text)) return { ok: false, reason: 'it has no "DONE fail=0" line' }
	return { ok: true, reason: '' }
}

export function gateRecordPath(root, tree) {
	return join(root, GATE_DIR, `${tree}.txt`)
}

/** The writer a gate runner calls after a full pass: `pnpm release record-gates --summary <file>`. */
export function recordGates(flags, deps) {
	if (!flags.summary) fail('record-gates needs --summary <path to the gate summary>')
	const tree = must(deps, 'git', ['rev-parse', 'HEAD^{tree}'], 'reading the tree').trim()
	const head = must(deps, 'git', ['rev-parse', 'HEAD'], 'reading HEAD').trim()
	const summary = deps.readFile(flags.summary)
	if (!/\bDONE\s+fail=0\b/.test(summary) || /fail=(?!0\b)\d+/.test(summary)) {
		fail(`${flags.summary} does not say "DONE fail=0"; no record written.`)
	}
	const dir = join(deps.root, GATE_DIR)
	deps.mkdir(dir)
	const path = gateRecordPath(deps.root, tree)
	deps.writeFile(path, `tree ${tree}\ncommit ${head}\nat ${deps.now().toISOString()}\n${summary.trimEnd()}\n`)
	deps.log(`gate record written: ${path}`)
	return path
}

function requireGateProof(flags, tree, deps) {
	const path = flags.gates ? flags.gates : gateRecordPath(deps.root, tree)
	if (!deps.exists(path)) {
		fail(
			`no gate record for this tree (${tree.slice(0, 12)}). Run the full gates (docs/cli/releasing.md), then\n` +
				'  pnpm release record-gates --summary <gate summary>\n' +
				'or pass --gates <summary path> naming this tree with DONE fail=0.',
		)
	}
	const r = parseGateProof(deps.readFile(path), tree)
	if (!r.ok) fail(`the gate proof ${path} does not hold: ${r.reason}.`)
	deps.log(`gates: passed on this tree (${path})`)
}

function publishablePackages(deps) {
	const out = must(deps, 'pnpm', ['list', '-r', '--depth', '-1', '--json'], 'listing packages')
	return JSON.parse(out)
		.filter((p) => p.name && p.version && p.private !== true && p.name !== 'namzu')
		.map((p) => ({ name: p.name, version: p.version }))
}

/** true when the registry has exactly this version; false on a clean 404; refuses on anything else. */
export function onRegistry(deps, name, version) {
	const r = deps.run('npm', ['view', `${name}@${version}`, 'version'])
	if (r.status === 0) return (r.stdout ?? '').trim() === version
	if (/E404|404 Not Found/i.test(`${r.stderr}${r.stdout}`)) return false
	fail(`could not ask the registry about ${name}@${version}: ${(r.stderr || r.stdout || '').trim()}`)
}

// ---- pnpm release version --------------------------------------------------------------------

export function versionStep(flags, deps) {
	const status = must(deps, 'git', ['status', '--porcelain'], 'reading the working tree')
	if (status.trim() !== '') fail('the working tree is not clean; commit or remove the changes first.')
	const before = publishablePackages(deps)
	must(deps, 'pnpm', ['changeset', 'version'], 'changeset version', { inherit: true })
	const after = publishablePackages(deps)
	const old = new Map(before.map((p) => [p.name, p.version]))
	const bumps = after.filter((p) => old.get(p.name) !== p.version)
	if (bumps.length === 0) {
		deps.log('no package version changed: there was no changeset to apply.')
		return bumps
	}
	deps.log('version bumps:')
	for (const p of bumps) deps.log(`  ${p.name}  ${old.get(p.name) ?? '(new)'} -> ${p.version}`)
	deps.log(
		'\nStopping here. Put this on a branch, commit it as "chore(release): version packages", open a PR and merge it;\n' +
			'then, from main with the gates recorded, run `pnpm release local`.',
	)
	return bumps
}

// ---- pnpm release local ----------------------------------------------------------------------

export async function releaseLocal(flags, deps) {
	const dry = flags['dry-run'] === true
	const { head, tree } = requireCleanMain(deps)
	deps.log(`HEAD is origin/main at ${head.slice(0, 9)}, tree ${tree.slice(0, 12)}, working tree clean`)
	requireNoPendingChangesets(deps)
	deps.log('changesets: none pending')
	requireGateProof(flags, tree, deps)

	must(deps, 'pnpm', ['-r', 'build'], 'build', { inherit: true })
	must(deps, 'node', ['--import', 'tsx', '--test', 'scripts/__tests__/verify-consumer-install-snapshot.test.ts'], 'consumer install snapshot test', { inherit: true })
	must(deps, 'bash', ['.github/scripts/verify-consumer-install.sh'], 'pre-publish consumer install check', { inherit: true })
	must(deps, 'node', ['.github/scripts/check-publish-metadata.mjs'], 'publish-metadata gate', { inherit: true })
	const after = must(deps, 'git', ['status', '--porcelain'], 'reading the working tree')
	if (after.trim() !== '') fail(`the checks left the working tree dirty:\n${after}`)
	deps.log('checks: build, consumer install, publish metadata passed')

	const who = deps.run('npm', ['whoami'])
	if (who.status !== 0 || !(who.stdout ?? '').trim()) {
		fail('not signed in to npm. Run `npm login --auth-type=web` in this shell, then run this again.')
	}
	deps.log(`npm: signed in as ${who.stdout.trim()}`)

	const toPublish = []
	for (const p of publishablePackages(deps)) {
		if (onRegistry(deps, p.name, p.version)) deps.log(`skip ${p.name}@${p.version}: already on the registry`)
		else toPublish.push(p)
	}
	if (toPublish.length === 0) {
		deps.log('nothing to publish: every version is already on the registry.')
		return { published: [], tags: [] }
	}
	deps.log(`${dry ? 'would publish' : 'publishing'}:`)
	for (const p of toPublish) deps.log(`  ${p.name}@${p.version}`)
	if (dry) {
		deps.log('dry run: not publishing, not pushing tags.')
		return { published: [], tags: [], dryRun: true, toPublish }
	}

	const args = ['changeset', 'publish']
	if (flags.otp) args.push('--otp', flags.otp)
	must(deps, 'pnpm', args, 'changeset publish', { inherit: true })

	const missing = []
	for (const p of toPublish) {
		let seen = false
		for (let i = 0; ; i++) {
			if (onRegistry(deps, p.name, p.version)) {
				seen = true
				break
			}
			if (i >= VERIFY_DELAYS_MS.length) break
			await deps.sleep(VERIFY_DELAYS_MS[i])
		}
		if (!seen) missing.push(`${p.name}@${p.version}`)
	}
	if (missing.length > 0) {
		fail(
			`the registry does not show: ${missing.join(', ')}. Tags were NOT pushed. Check \`npm view <pkg> version\` again in a few minutes; ` +
				'never unpublish. When every version shows, push the tags by hand (git push origin <tag>).',
		)
	}
	deps.log('registry: every published version is visible')

	const existing = new Set(must(deps, 'git', ['tag', '--list'], 'listing tags').split('\n').map((s) => s.trim()))
	const tags = toPublish.map((p) => `${p.name}@${p.version}`).filter((t) => existing.has(t))
	if (tags.length > 0) {
		must(deps, 'git', ['push', 'origin', ...tags.map((t) => `refs/tags/${t}`)], 'pushing tags')
		deps.log(`tags pushed: ${tags.join(', ')}`)
	}

	const notePath = join(deps.root, '.release', 'notes', `release-${deps.now().toISOString().slice(0, 10)}-${head.slice(0, 9)}.md`)
	deps.mkdir(dirname(notePath))
	deps.writeFile(
		notePath,
		[
			`# Release ${deps.now().toISOString()}`,
			'',
			`Commit ${head}, tree ${tree}. Published by hand with \`pnpm release local\`.`,
			'',
			...toPublish.map((p) => `- ${p.name}@${p.version}`),
			'',
			`Tags pushed: ${tags.length ? tags.join(', ') : 'none (changesets made no tag)'}`,
			'',
		].join('\n'),
	)
	deps.log(`release note: ${notePath}`)
	deps.log('GitHub Releases are not created by this command; fill them with `node .github/scripts/backfill-github-releases.mjs` when gh can write.')
	return { published: toPublish, tags, notePath }
}

// ---- Desktop ---------------------------------------------------------------------------------

function desktopFacts(flags, deps) {
	const pkg = JSON.parse(deps.readFile(join(deps.root, 'packages/desktop/package.json')))
	if (flags.version && flags.version !== pkg.version) {
		fail(`packages/desktop/package.json is ${pkg.version} but --version asked for ${flags.version}.`)
	}
	return { version: pkg.version, electron: pkg.devDependencies?.electron ?? '' }
}

function requireChangelog(version, deps) {
	const text = deps.readFile(join(deps.root, 'packages/desktop/CHANGELOG.md'))
	const esc = version.replace(/[.+]/g, '\\$&')
	if (!new RegExp(`^## ${esc}\\s*$`, 'm').test(text)) {
		fail(`packages/desktop/CHANGELOG.md has no "## ${version}" section; merge the version PR first.`)
	}
}

export function desktopStage(flags, deps) {
	const { version, electron } = desktopFacts(flags, deps)
	requireCleanMain(deps)
	requireChangelog(version, deps)
	for (const f of ['pal-computer-image', 'pal-computer-manifest']) {
		if (!flags[f]) {
			fail(
				`--${f} is required. Take the archive and manifest of the previous installer (or build them with ` +
					'packages/sandbox/local-computer/build-image.mjs, see docs/cli/desktop.md).',
			)
		}
		if (!deps.exists(flags[f])) fail(`--${f} ${flags[f]} does not exist.`)
	}
	const out = flags.out ?? join(deps.root, '.release', `desktop-stage-${version}`)
	must(deps, 'pnpm', ['-r', 'build'], 'build', { inherit: true })
	must(deps, 'node', ['packages/desktop/scripts/stage-installer.mjs', out, '--pal-computer-image', flags['pal-computer-image'], '--pal-computer-manifest', flags['pal-computer-manifest']], 'stage-installer', { inherit: true })
	must(deps, 'node', ['packages/desktop/scripts/check-pal-image.mjs', 'archive', join(out, 'extra/pal-computer')], 'check-pal-image', { inherit: true })
	const tgz = `${out}.tgz`
	must(deps, 'tar', ['-czf', tgz, '-C', out, '.'], 'packing the staged project')
	deps.log(`
Staged Namzu Desktop ${version}: ${tgz}

The Windows step is the only one left, and it runs on Windows (electron-builder cannot make the
installer here). On the Windows machine, in PowerShell:

  mkdir stage; tar -xzf stage.tgz -C stage
  mkdir tools; cd tools; npm install --save-exact --ignore-scripts --no-audit --no-fund electron-builder@${ELECTRON_BUILDER_VERSION}; cd ..
  cd stage
  $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  node ..\\tools\\node_modules\\electron-builder\\cli.js --win nsis --x64 --publish never --config electron-builder.yml "--config.electronVersion=${electron}"

Check that out\\ holds Namzu-Setup-${version}.exe, Namzu-Setup-${version}.exe.blockmap and latest.yml. Copy exactly
those three files into one folder on this machine, then:

  pnpm release desktop publish --installer <that folder> --dry-run
  pnpm release desktop publish --installer <that folder>
`)
	return { out, tgz }
}

export function compareVersions(a, b) {
	const [ca, ...pa] = a.split('-')
	const [cb, ...pb] = b.split('-')
	const core = (v) => v.split(/[.+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
	const x = core(ca)
	const y = core(cb)
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		if (x[i] === y[i]) continue
		if (x[i] === undefined) return -1
		if (y[i] === undefined) return 1
		if (typeof x[i] === 'number' && typeof y[i] === 'number') return x[i] - y[i]
		return String(x[i]) < String(y[i]) ? -1 : 1
	}
	// a release outranks its own pre-release
	if (pa.length !== pb.length) return pa.length === 0 ? 1 : -1
	return pa.join('-') === pb.join('-') ? 0 : pa.join('-') < pb.join('-') ? -1 : 1
}

const installerVersions = (names) =>
	names
		.map((n) => /^Namzu-Setup-(.*)\.exe$/.exec(n)?.[1])
		.filter(Boolean)
		.sort((a, b) => compareVersions(b, a))

export function desktopPublish(flags, deps) {
	const dry = flags['dry-run'] === true
	const { version } = desktopFacts(flags, deps)
	requireCleanMain(deps)
	requireChangelog(version, deps)
	if (!flags.installer) fail('--installer <folder with the three files from the Windows step> is required.')
	const dir = resolve(flags.installer)
	const exe = `Namzu-Setup-${version}.exe`
	const expected = ['latest.yml', exe, `${exe}.blockmap`].sort().join(',')
	const files = deps.readDir(dir).sort().join(',')
	if (files !== expected) fail(`${dir} must hold exactly ${expected}; it holds ${files || 'nothing'}.`)
	const yml = deps.readFile(join(dir, 'latest.yml'))
	const field = (name) => (yml.match(new RegExp(`^${name}:\\s*(\\S+)\\s*$`, 'm')) ?? [])[1]
	if (field('version') !== version) fail(`latest.yml version is ${field('version')}, expected ${version}`)
	if (field('path') !== exe) fail(`latest.yml path is ${field('path')}, expected ${exe}`)
	if (field('sha512') !== deps.sha512(join(dir, exe))) fail(`latest.yml sha512 does not match ${exe}`)
	deps.log('installer: latest.yml names this installer and its sha512')

	const env = { GH_REPO: deps.repo }
	must(deps, 'gh', ['auth', 'status'], 'gh sign-in (run `gh auth login`)', { env })
	const view = deps.run('gh', ['release', 'view', FEED_TAG], { env })
	const exists = view.status === 0
	if (!exists) {
		if (dry) deps.log(`would create the rolling release ${FEED_TAG}`)
		else {
			must(deps, 'gh', ['release', 'create', FEED_TAG, '--prerelease', '--latest=false', '--title', 'Namzu Desktop', '--notes', 'Update feed read by the installed Namzu Desktop app. It holds the newest installer and the one before it; do not delete this release.'], 'creating the release', { env })
		}
	}
	const assets = exists
		? must(deps, 'gh', ['release', 'view', FEED_TAG, '--json', 'assets', '--jq', '.assets[].name'], 'reading the feed', { env }).split('\n').map((s) => s.trim()).filter(Boolean)
		: []
	if (assets.includes(exe)) fail(`${exe} is already on ${FEED_TAG}; bump the version instead.`)
	const previous = installerVersions(assets).find((v) => /^\d+\.\d+\.\d+([-+.][0-9A-Za-z.]+)?$/.test(v)) ?? ''
	deps.log(`previous installer on the feed: ${previous || 'none'}`)

	const notes = join(deps.root, '.release', `desktop-notes-${version}.md`)
	deps.mkdir(dirname(notes))
	must(deps, 'node', ['packages/desktop/scripts/feed-release-notes.mjs', '--version', version, ...(previous ? ['--previous', previous] : []), '--installer', join(dir, exe), '--out', notes], 'feed-release-notes', { env: { GH_TOKEN: '' } })
	deps.log(`release notes: ${notes}`)

	const steps = [
		['upload', FEED_TAG, join(dir, exe), join(dir, `${exe}.blockmap`)],
		['upload', FEED_TAG, '--clobber', join(dir, 'latest.yml')],
		['edit', FEED_TAG, '--title', `Namzu Desktop ${version}`, '--notes-file', notes],
	]
	const olds = installerVersions([...assets, exe]).slice(2)
	if (dry) {
		deps.log('dry run: would run')
		for (const s of steps) deps.log(`  gh release ${s.join(' ')}`)
		for (const o of olds) deps.log(`  gh release delete-asset ${FEED_TAG} Namzu-Setup-${o}.exe --yes (and its blockmap)`)
		return { dryRun: true, previous, steps, olds }
	}
	for (const s of steps) must(deps, 'gh', ['release', ...s], `gh release ${s[0]}`, { env })
	for (const o of olds) {
		must(deps, 'gh', ['release', 'delete-asset', FEED_TAG, `Namzu-Setup-${o}.exe`, '--yes'], `removing ${o}`, { env })
		deps.run('gh', ['release', 'delete-asset', FEED_TAG, `Namzu-Setup-${o}.exe.blockmap`, '--yes'], { env })
	}
	deps.log(`published Namzu Desktop ${version} to ${FEED_TAG}`)
	return { published: version, previous, olds }
}

// ---- entry -----------------------------------------------------------------------------------

export async function main(argv, deps) {
	const { words, flags } = parseArgs(argv)
	const [cmd, sub] = words
	if (cmd === 'local') return releaseLocal(flags, deps)
	if (cmd === 'version') return versionStep(flags, deps)
	if (cmd === 'record-gates') return recordGates(flags, deps)
	if (cmd === 'desktop' && sub === 'publish') return desktopPublish(flags, deps)
	if (cmd === 'desktop' && sub === undefined) return desktopStage(flags, deps)
	fail('usage: pnpm release <version | local [--dry-run] [--gates <summary>] [--otp <code>] | record-gates --summary <file> | desktop [publish] ...>\nSee docs/cli/releasing.md.')
}

export function realDeps(root) {
	return {
		root,
		repo: process.env.GH_REPO || 'cogitave/namzu',
		run(cmd, args, opts = {}) {
			const r = spawnSync(cmd, args, {
				cwd: root,
				encoding: 'utf8',
				env: { ...process.env, ...(opts.env ?? {}) },
				stdio: opts.inherit ? 'inherit' : 'pipe',
				maxBuffer: 64 * 1024 * 1024,
			})
			return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') }
		},
		readFile: (p) => readFileSync(p, 'utf8'),
		writeFile: (p, t) => writeFileSync(p, t),
		mkdir: (p) => mkdirSync(p, { recursive: true }),
		exists: (p) => existsSync(p),
		readDir: (p) => readdirSync(p),
		sha512: (p) => createHash('sha512').update(readFileSync(p)).digest('base64'),
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		now: () => new Date(),
		log: (m) => console.log(m),
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const here = dirname(fileURLToPath(import.meta.url))
	const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: here, encoding: 'utf8' }).stdout.trim() || resolve(here, '..')
	main(process.argv.slice(2), realDeps(root)).catch((error) => {
		console.error(error instanceof Refusal ? `refused: ${error.message}` : error)
		process.exit(1)
	})
}
