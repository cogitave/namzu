/** The worktree settings in force for this process: the user's own file and the managed file. */

import { loadBootstrapConfigWithProvenance } from '../../config/load.js'
import type { WorktreeSettings } from '../../config/worktree-settings.js'

/**
 * Read once per worktree manager, so a change reaches the next worktree made after it. A file that
 * cannot be read gives the defaults: making a worktree does not depend on a settings file, and the
 * loader reports a bad file wherever it is loaded for a conversation.
 */
export function readWorktreeSettings(): WorktreeSettings {
	try {
		return loadBootstrapConfigWithProvenance({}).config.worktrees ?? {}
	} catch {
		return {}
	}
}
