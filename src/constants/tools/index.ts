export const DANGEROUS_PATTERNS = [/rm\s+-rf\s+\//, /mkfs/, /dd\s+if=/, /:(){ :\|:& };:/]

export const FILESYSTEM_TOOLS = new Set(['glob', 'read_file', 'write_file', 'bash'])
