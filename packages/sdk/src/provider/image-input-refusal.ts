import { isProviderRequestError } from './errors.js'

/**
 * Wording providers use when they refuse a request because it carries an image
 * and the model behind it reads text only. There is no shared error code for
 * this: each vendor writes its own sentence, so the match is by phrase, and it
 * is only applied to a 400-class `bad_request` where the alternative is a hard
 * failure anyway.
 */
const IMAGE_INPUT_REFUSAL_PATTERNS: readonly RegExp[] = [
	// "Beam supports text input only. This conversation contains an image."
	/\btext[- ]only\b/i,
	/\b(?:supports?|accepts?|takes?|handles?)\s+(?:only\s+)?text\b/i,
	/\bcontains?\s+an?\s+image\b.{0,120}\b(?:remove|text)\b/i,
	// "does not support image input", "doesn't support vision", "no vision support"
	/\b(?:does\s?n[o']t|do\s+not|cannot|can['’]t|not)\s+(?:support|accept|handle|process|read|understand)\w*\s+(?:image|vision|multimodal|visual|picture)/i,
	/\b(?:image|vision|multimodal|visual)\s+(?:input|content|inputs|understanding|modality)\b.{0,60}\b(?:not\s+(?:supported|enabled|available|allowed)|unsupported)/i,
	/\bimages?\s+(?:are|is)\s+(?:not\s+supported|unsupported|not\s+allowed)\b/i,
	// Chat-completions servers that only know text parts.
	/\bimage_url\b.{0,60}\b(?:only\s+supported\s+by|not\s+supported|unsupported)/i,
	/\bunknown\s+variant\b.{0,10}\bimage_url\b/i,
	/\binvalid\s+content\s+type\b.{0,60}\bimage/i,
]

/** Whether a provider's refusal text says "this model cannot take images". */
export function isImageInputRefusalMessage(text: string | undefined): boolean {
	if (!text) return false
	return IMAGE_INPUT_REFUSAL_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * Whether `error` is a provider refusing the request because of an image it
 * holds that the model cannot read. Resending the same request can never help;
 * only removing the image or choosing a model that reads images does.
 */
export function isImageInputRefusal(error: unknown): boolean {
	if (!isProviderRequestError(error) || error.kind !== 'bad_request') return false
	return isImageInputRefusalMessage(error.detail ?? error.message)
}
