/**
 * The word a person uses for a permission mode. The kernel's `classify` is the mode the screen calls `auto`,
 * and the kernel's `auto` is the one the screen calls `unattended`. Everything a person or a model reads about
 * a mode (notices, held-mail reasons, the wrapper of a message from another terminal) goes through this;
 * the kernel names stay in JSON, files and the wire.
 *
 * @experimental
 */
export function permissionModeWord(mode: string): string {
	switch (mode) {
		case 'classify':
			return 'auto'
		case 'auto':
			return 'unattended'
		default:
			return mode
	}
}
