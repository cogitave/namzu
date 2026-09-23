/**
 * A Linux desktop notification over the session bus: `notify-send` when it
 * is installed (arguments are argv, never a shell), else `gdbus`, whose
 * arguments are GVariant text and so are quoted as GVariant strings here.
 */

/** A GVariant string literal: single-quoted, backslash and quote escaped. */
export function gvariantString(text: string): string {
	return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

export function notifySendArguments(title: string, body: string): string[] {
	return ['--app-name=namzu', '--', title, body]
}

export function gdbusArguments(title: string, body: string): string[] {
	return [
		'call',
		'--session',
		'--dest',
		'org.freedesktop.Notifications',
		'--object-path',
		'/org/freedesktop/Notifications',
		'--method',
		'org.freedesktop.Notifications.Notify',
		gvariantString('namzu'),
		'0',
		gvariantString(''),
		gvariantString(title),
		gvariantString(body),
		'[]',
		'{}',
		'10000',
	]
}
