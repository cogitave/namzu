// The specifiers the CLI bundle leaves external. This is the one list: scripts/bundle.mjs hands it to
// esbuild, and the Desktop installer's staging reads it to decide which packages stay on disk
// (packages/desktop/scripts/lean-cli.mjs). A package added here is shipped; one left out is not.
//
// Kept external, because they are native, optional, or found by name or path at run time:
//   @namzu/browser, @namzu/sandbox, @namzu/telemetry, @namzu/computer-use  optional packages
//   node-pty, playwright-core, react-devtools-core                         native / by path / optional
//   sharp                                                                   native, optional; loaded on first use to shrink a pasted image
//   oxc-parser                                                             native; a real dependency (@namzu/analysis itself is bundled, like @namzu/decision)
//   quickjs-emscripten-core, @jitl/quickjs-wasmfile-release-sync           resolved by path
export const external = [
	'@namzu/browser',
	'@namzu/sandbox',
	'@namzu/telemetry',
	'@namzu/computer-use',
	'node-pty',
	'sharp',
	'@lydell/node-pty',
	'oxc-parser',
	'playwright-core',
	'react-devtools-core',
	'quickjs-emscripten-core',
	'@jitl/quickjs-wasmfile-release-sync',
]
