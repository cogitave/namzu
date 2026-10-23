import { describe, it } from 'vitest'
import { resolveSidecar } from '../resolve.js'

/**
 * Suites that spawn the real sidecar.
 *
 * Without a built binary: in CI the suite fails (a skipped native test there
 * would pass the build against no binary at all), and locally it is skipped
 * with a logged reason so a contributor with no Rust toolchain is not blocked.
 */
export const sidecar = resolveSidecar()

export function describeNative(name: string, body: () => void): void {
	if (sidecar) {
		describe(name, body)
	} else if (process.env.CI) {
		describe(name, () => {
			it('needs the built sidecar binary, which CI must provide', () => {
				throw new Error(
					'the sidecar binary is missing in CI: `pnpm --filter @namzu/analysis-native build` must run first',
				)
			})
		})
	} else {
		// biome-ignore lint/suspicious/noConsole: the reason a suite was skipped must reach the log
		console.warn(
			`[analysis-native] skipping "${name}": the sidecar binary is not built and CI is unset. Run \`pnpm --filter @namzu/analysis-native build\` (needs Rust).`,
		)
		describe.skip(name, body)
	}
}
