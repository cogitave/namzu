import { isProviderRequestError } from './errors.js'

/**
 * Wording providers use when they refuse a request because the MODEL reads text
 * only. There is no shared error code for this: each vendor writes its own
 * sentence, so the match is by phrase.
 *
 * Every pattern names the model's input as text-only, or says the model does not
 * take image input at all. A 400 about one image (its size, its format, its URL)
 * or about text somewhere else in the request (a tool message, an output
 * format) is not this, and must not match: the caller drops every image and
 * stops sending any to the model for the rest of the conversation.
 */
const IMAGE_INPUT_REFUSAL_PATTERNS: readonly RegExp[] = [
	// Zen: "Beam supports text input only. This conversation contains an image."
	/\btext\s+inputs?\s+only\b/i,
	/\bonly\s+(?:supports?|accepts?)\s+text\s+inputs?\b/i,
	/\bonly\s+text\s+inputs?\s+(?:is|are)\s+(?:supported|accepted|allowed)\b/i,
	// "This model is text-only", "a text-only model"
	/\btext[- ]only\s+model\b/i,
	/\bmodel\b[^.;]{0,40}\bis\s+(?:a\s+)?text[- ]only\b/i,
	// Local model servers: "<model> does not support images", "Model does not
	// support images. Please use a model that does." Also "doesn't support vision",
	// "does not support image input", "does not support multimodal inputs".
	/\b(?:does\s?n[o'’]t|do\s+not|cannot|can[’']t)\s+(?:support|accept)\s+(?:images|vision)\b(?![/\w-])/i,
	/\b(?:does\s?n[o'’]t|do\s+not|cannot|can[’']t)\s+(?:support|accept|process|handle)\s+(?:image|vision|multimodal|visual)\s+inputs?\b/i,
	// A local inference server: "image input is not supported - hint: ... mmproj". The
	// sentence must end there or name the model: "image input is not supported
	// on streaming" is a restriction of the endpoint, not of the model.
	/\b(?:image|vision|multimodal)\s+inputs?\s+(?:is|are)\s+(?:not\s+supported|unsupported)(?:\s+(?:by|for)\s+(?:this|the)\s+model)?\s*(?:$|[.;:,!)\-])/i,
	/\bimages\s+(?:is|are)\s+not\s+supported(?:\s+(?:by|for)\s+(?:this|the)\s+model)?\s*(?:$|[.;:,!)\-])/i,
	// A serving engine: "<model> is not a multimodal model"
	/\bis\s+not\s+a\s+(?:multimodal|vision)\s+model\b/i,
	// A chat-completions API: "Invalid content type. image_url is only supported by certain models."
	/\bimage_url\b.{0,40}\bonly\s+supported\s+by\s+certain\s+models\b/i,
	// A chat-completions server that only knows text parts: "unknown variant `image_url`, expected `text`"
	/\bunknown\s+variant\s+\W?image_url\W?,?\s+expected\s+\W?text\b/i,
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
