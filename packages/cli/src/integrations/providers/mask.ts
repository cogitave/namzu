/**
 * Mask a secret for terminal display. Default keeps the last 4 chars
 * (familiar from `aws configure list-profiles` / `gh auth status`).
 * Returns `null` for null/empty inputs (so callers can render "—").
 */
export function maskSecret(secret: string | null | undefined, keep = 4): string | null {
	if (!secret) return null
	if (secret.length <= keep) return '***'
	const tail = secret.slice(-keep)
	return `***${tail}`
}
