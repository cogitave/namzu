import type { ConnectorExecuteResult } from '../../types/connector/index.js'

/** Keep remote side-effect uncertainty in the text the model actually sees. */
export function connectorToolError(result: ConnectorExecuteResult): string {
	const base = result.error ?? 'Connector execution failed'
	const normalized = base.toLowerCase()
	const outcome = result.metadata?.remoteOutcome
	const retrySafety = result.metadata?.retrySafety
	if (outcome === 'not_started' && !normalized.includes('no remote request was started')) {
		return `${base} No remote request was started; retry is safe.`
	}
	if (outcome === 'unknown' && !normalized.includes('remote outcome is unknown')) {
		return retrySafety === 'safe'
			? `${base} The remote outcome is unknown, but retry is safe for this operation.`
			: `${base} The remote outcome is unknown; do not automatically retry.`
	}
	if (outcome === 'response_received' && !normalized.includes('response')) {
		return `${base} A remote response was received; use its status before deciding whether to retry.`
	}
	return base
}
