/**
 * Pasted text reaches a program as if typed. The emulator brackets it when the program asked for
 * that, but it does not remove an embedded end-of-paste sequence, so text from a hostile page could
 * close the bracket and continue as typed commands. Control characters other than tab and line
 * breaks are dropped before the text goes in.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point.
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu

export function sanitizePaste(text: string): string {
	return text.replace(CONTROLS, '')
}

/** More than one line pasted into a program that did not ask for bracketing runs line by line at once. */
export function pasteNeedsConfirmation(text: string, bracketed: boolean): boolean {
	return !bracketed && /[\r\n]./u.test(text.replace(/[\r\n]+$/u, ''))
}

export function pasteLineCount(text: string): number {
	return text.replace(/[\r\n]+$/u, '').split(/\r\n|\r|\n/u).length
}
