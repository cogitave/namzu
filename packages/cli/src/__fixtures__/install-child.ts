import { planInstall } from '../integrations/plugins/install-plan.js'
/**
 * A second process that installs plugin folders into the same Namzu home, for
 * the test that two writers never lose each other's records. Arguments: the
 * Namzu home, the folder to install for, then the plugin folders.
 */
import { commitInstall } from '../integrations/plugins/install.js'

const [home, cwd, ...folders] = process.argv.slice(2) as [string, string, ...string[]]
for (const folder of folders) {
	const plan = await planInstall({ kind: 'path', path: folder }, { home, cwd })
	commitInstall(plan, {
		home,
		now: new Date('2026-11-27T10:00:00.000Z'),
		scope: 'user',
		cwd,
		consent: { by: 'cli', nonInteractive: true },
	})
}
