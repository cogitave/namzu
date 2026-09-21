import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Vitest global setup: give the kernel's default state root a scratch home.
 *
 * An SDK entry point with no path builder writes under `defaultStateRoot()`,
 * which is the user's own state directory (`~/.local/state/namzu` and the
 * platform equivalents). A test that calls `query`, `drainQuery` or
 * `runAgent` without one must not write there, and before that default
 * existed it wrote into the package checkout instead (`<cwd>/.namzu`).
 * `NAMZU_STATE_DIR` wins over the platform default, the forked workers
 * inherit it, and the directory is removed when the run ends.
 */
export default function setup() {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "namzu-test-state-"));
	process.env.NAMZU_STATE_DIR = root;
	const cleanup = () => rmSync(root, { recursive: true, force: true });
	process.once("exit", cleanup);
	return cleanup;
}
