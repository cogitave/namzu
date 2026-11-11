import {
	approveLabel,
	mcpServerRowView,
	mcpServersNote,
	waitingServers,
} from './mcp-servers-model.js'
import { Row } from './settings-row.js'
import { Button } from './ui/button.js'
import type { McpServersControls } from './use-mcp-servers.js'

/**
 * The project's tool servers, read from the engine: where each is defined and where it stands.
 * Read-only, apart from approving the ones a project's `.mcp.json` asks to start.
 */
export function McpServersRows({
	servers,
	projectName,
}: {
	servers: McpServersControls
	projectName?: string
}) {
	if (!servers.supported) return null
	const waiting = waitingServers(servers.view)
	const rows = (servers.view?.servers ?? []).map(mcpServerRowView)
	return (
		<Row
			id="mcpServers"
			label="Connected servers"
			description={mcpServersNote(projectName)}
			stacked
		>
			<div className="mcp-servers">
				{servers.loading && !servers.view && (
					<p className="settings-note">Reading the tool servers…</p>
				)}
				{servers.error && (
					<p role="alert" className="settings-error">
						{servers.error}
					</p>
				)}
				{servers.view?.error && (
					<p role="alert" className="settings-error">
						{servers.view.error}
					</p>
				)}
				{waiting.length > 0 && (
					<div className="mcp-waiting">
						<p>
							{waiting.length === 1
								? 'A tool server from this project’s .mcp.json is waiting for your approval and has not started.'
								: `${waiting.length} tool servers from this project’s .mcp.json are waiting for your approval and have not started.`}{' '}
							Approving lets them run the programs listed below on your computer.
						</p>
						<Button
							variant="outline"
							size="sm"
							disabled={servers.approving}
							onClick={() => void servers.approve()}
						>
							{approveLabel(waiting.length)}
						</Button>
					</div>
				)}
				{rows.length === 0 && !servers.loading && !servers.error && !servers.view?.error && (
					<p className="settings-note">No tool servers are set up for this project.</p>
				)}
				{rows.length > 0 && (
					<ul className="mcp-server-list" aria-label="Tool servers">
						{rows.map((row) => (
							<li key={row.name} className="mcp-server" data-state={row.state}>
								<div className="mcp-server-main">
									<span className="mcp-server-name">{row.name}</span>
									<span className="mcp-server-where">
										{row.where}
										{row.detail ? ` · ${row.detail}` : ''}
									</span>
									{row.reason && <span className="mcp-server-reason">{row.reason}</span>}
								</div>
								<span className="settings-badge" data-tone={row.state}>
									{row.stateLabel}
								</span>
							</li>
						))}
					</ul>
				)}
			</div>
		</Row>
	)
}
