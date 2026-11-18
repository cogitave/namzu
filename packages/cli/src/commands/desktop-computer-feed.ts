/**
 * What the model saw after a `computer_use` call, told to the desktop so a person can see it too.
 * The picture is made small before it leaves the engine; the desktop keeps only the newest few.
 * One `namzu/` notification per call that returned a screenshot, beside the usage and outcome ones.
 */
export const COMPUTER_FRAME_NOTIFICATION = 'namzu/session/computer-frame'

export interface ComputerFrameNotification {
	readonly sessionId: string
	/** The tool call this belongs to, as the call row names it. */
	readonly toolUseId?: string
	readonly frameId: string
	/** What the model did that produced this picture, in the words of the call row. */
	readonly action: string
	/** The application the call worked on, when it could be told. */
	readonly app?: string
	readonly mimeType: 'image/png'
	/** The picture, base64. */
	readonly data: string
	readonly width: number
	readonly height: number
	/** Where a click landed, as fractions of the picture, when the call clicked. */
	readonly point?: { readonly x: number; readonly y: number }
}
