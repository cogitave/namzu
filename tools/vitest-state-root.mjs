import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Vitest global setup: give the kernel's state a scratch home.
 *
 * `NAMZU_HOME` is the session layout's home (`~/.namzu` by default, see
 * `packages/sdk/src/session/home.ts`). `resolveNamzuHome` requires an
 * explicit value to be an existing real directory, so it is created here.
 *
 * A test that calls `query`, `drainQuery` or `runAgent` without its own
 * storage must write into neither the user's home nor the package checkout.
 * The forked workers inherit the variable, and the directory is removed
 * when the run ends.
 */
export default function setup() {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "namzu-test-state-"));
	const home = join(root, "home");
	mkdirSync(home);
	process.env.NAMZU_HOME = home;
	const cleanup = () => rmSync(root, { recursive: true, force: true });
	process.once("exit", cleanup);
	return cleanup;
}
