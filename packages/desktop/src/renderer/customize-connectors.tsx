import { CONNECTOR_COLUMNS, type ConnectorRowModel, NO_CONNECTORS } from './customize-model.js'
import { EmptyState } from './customize-parts.js'
import { CheckIcon, PlugIcon } from './icons.js'
import { Button } from './ui/button.js'

function StatusCell({
	row,
	approving,
	onApprove,
}: { row: ConnectorRowModel; approving: boolean; onApprove: () => void }) {
	switch (row.status.kind) {
		case 'connected':
			return (
				<span className="customize-status-ok" role="img" aria-label="Connected">
					<CheckIcon aria-hidden="true" />
				</span>
			)
		case 'approve':
			return (
				<Button
					variant="outline"
					size="xs"
					disabled={approving}
					aria-label={`Approve ${row.name}`}
					onClick={(event) => {
						event.stopPropagation()
						onApprove()
					}}
				>
					Approve
				</Button>
			)
		case 'failed':
			return (
				<span className="customize-status-failed" title={row.status.reason}>
					Failed
				</span>
			)
		default:
			return <span className="customize-muted">—</span>
	}
}

/** The Connectors tab: one row per tool server, a column each for what it is, where it is set and how it stands. */
export function ConnectorsTable({
	rows,
	approving,
	onOpen,
	onApprove,
	onAdd,
	searching,
}: {
	rows: readonly ConnectorRowModel[]
	approving: boolean
	onOpen: (name: string) => void
	onApprove: () => void
	onAdd?: () => void
	searching: boolean
}) {
	if (rows.length === 0)
		return searching ? (
			<EmptyState>No connectors match your search.</EmptyState>
		) : (
			<EmptyState
				action={
					onAdd && (
						<Button variant="outline" size="sm" onClick={onAdd}>
							Add custom connector
						</Button>
					)
				}
			>
				{NO_CONNECTORS}
			</EmptyState>
		)
	return (
		<table className="customize-table">
			<thead>
				<tr>
					{CONNECTOR_COLUMNS.map((column) => (
						<th key={column} scope="col">
							{column}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{rows.map((row) => (
					// biome-ignore lint/a11y/useKeyWithClickEvents: the name button in the first cell is the keyboard way in
					<tr key={row.name} title={row.title} onClick={() => onOpen(row.name)}>
						<td>
							<button type="button" className="customize-table-name">
								<PlugIcon aria-hidden="true" />
								{row.name}
							</button>
						</td>
						<td>{row.type}</td>
						<td>{row.source}</td>
						<td>
							<StatusCell row={row} approving={approving} onApprove={onApprove} />
						</td>
					</tr>
				))}
			</tbody>
		</table>
	)
}
