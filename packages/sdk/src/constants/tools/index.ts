export const DANGEROUS_PATTERNS = [/rm\s+-rf\s+\//, /mkfs/, /dd\s+if=/, /:(){ :\|:& };:/]

/**
 * The name a tool may be registered under — and therefore the name the model
 * sees and calls. This is the intersection of what strict providers accept for
 * a function name: ASCII alphanumerics, underscore, hyphen, at most 64 chars.
 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
export const TOOL_NAME_MAX_LENGTH = 64

export const FILESYSTEM_TOOLS = new Set(['glob', 'read_file', 'write_file', 'bash'])
