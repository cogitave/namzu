// Run the repository's complete local gate set, preserving each real exit code.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
const repo = resolve(process.argv[2] ?? '.')
const logs = process.env.NAMZU_VALIDATION_LOGS ?? join(tmpdir(), `namzu-runtime-desktop-gates-${Date.now()}`)
mkdirSync(logs, { recursive: true })
const gates = [
 ['lint', 'pnpm lint'],
 ['workflow-tests', 'node --test scripts/__tests__/check-workflow-gate-parity.test.mjs scripts/__tests__/find-validated-tree.test.mjs'],
 ['workflow-parity', 'node .github/scripts/check-workflow-gate-parity.mjs'],
 ['project-references', 'node .github/scripts/check-project-references.mjs'],
 ['typecheck', 'pnpm typecheck'],
 ['build', 'pnpm -r build'],
 ['tests', 'pnpm -r test'],
 ['process-tests', 'pnpm --filter @namzu/sdk test:proc'],
 ['external-name-tests', 'node --import tsx --test scripts/__tests__/audit-external-names.test.ts'],
 ['external-names', 'node scripts/audit-external-names.mjs'],
 ['log-tests', 'node --import tsx --test scripts/__tests__/check-log-standard.test.ts'],
 ['log-standard', 'node scripts/check-log-standard.mjs'],
 ['local-entries', 'node --import tsx --test scripts/__tests__/check-local-entry.test.ts'],
 ['model-prices', 'node scripts/generate-model-prices.mjs --check'],
 ['zen-generator', 'node --import tsx --test scripts/__tests__/generate-zen-models.test.ts'],
 ['installer-sh', 'sh -n install.sh'],
 ['installer-dash', 'dash -n install.sh'],
 ['evals', 'node packages/cli/dist/bin.js eval --dir packages/evals --out eval-report.json'],
 ['coverage', 'pnpm --filter @namzu/sdk test:coverage'],
 ['coverage-floor', 'node .github/scripts/check-sdk-module-coverage.mjs'],
 ['test-presence', 'node .github/scripts/check-sdk-test-presence.mjs'],
 ['publish-metadata', 'node .github/scripts/check-publish-metadata.mjs'],
 ['consumer-snapshot-test', 'node --import tsx --test scripts/__tests__/verify-consumer-install-snapshot.test.ts'],
 ['consumer-install', 'bash .github/scripts/verify-consumer-install.sh'],
 ['signature-types', 'node .github/scripts/check-signature-types-exported.mjs'],
 ['docs-okf', 'pnpm docs:check'],
 ['docs-fences', 'node tools/check-doc-fences.mjs'],
]
const workspace = spawnSync('pnpm', ['list', '-r', '--depth', '-1', '--json'], { cwd: repo, encoding: 'utf8' })
if (workspace.status !== 0) throw new Error('Cannot enumerate the workspace.')
const publishable = JSON.parse(workspace.stdout).filter((row) => row.name && row.path && row.private !== true && row.name !== 'namzu')
if (!publishable.length) throw new Error('No publishable packages found.')
for (const row of publishable) gates.push([`publint-${relative(repo, row.path).replaceAll('/', '-')}`, ['npx', '-y', 'publint@latest', relative(repo, row.path)]])
const receipt = []
const from = process.env.NAMZU_VALIDATION_FROM
const start = from ? gates.findIndex(([name]) => name === from) : 0
if (start < 0) throw new Error(`Unknown validation stage: ${from}`)
console.log(JSON.stringify({ logs, gates: gates.length }))
for (const [name, command] of gates.slice(start).filter(([name]) => !process.env.NAMZU_VALIDATION_ONLY || name.startsWith(process.env.NAMZU_VALIDATION_ONLY))) {
 const argv = Array.isArray(command) ? [...command] : command.split(' ')
 if (name === 'installer-dash') argv[0] = process.env.NAMZU_DASH ?? 'dash'
 const result = spawnSync(argv[0], argv.slice(1), { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
 writeFileSync(join(logs, `${name}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ?? ''}`)
 receipt.push({ name, command, exitCode: result.status, signal: result.signal })
 writeFileSync(join(logs, 'results.json'), JSON.stringify(receipt, null, 2))
 console.log(JSON.stringify(receipt.at(-1)))
 if (result.status !== 0) { console.log((result.stdout ?? '').slice(-4000), (result.stderr ?? '').slice(-1500)); process.exit(result.status ?? 1) }
}
