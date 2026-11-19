import { useEffect, useState } from 'react'
import {
	type ExtensionDisclosure,
	type ExtensionNotice,
	type ExtensionRow,
	readNotice,
} from '../shared/extensions-view.js'
import type { Api } from './extension-dialogs.js'
import { Failure } from './extension-dialogs.js'
import {
	failureWords,
	keptWords,
	kindCounts,
	kindTitle,
	recordCountWords,
	rowsTable,
	titleSaysAll,
} from './extensions-model.js'
import { ask } from './extensions-store.js'
import { ArrowLeftIcon } from './icons.js'
import { Row } from './settings-row.js'
import { Button } from './ui/button.js'
import './extension-dialogs.css'
import './extensions-section.css'

/** "Kept 7 days." as the value of a row: no full stop. */
const keptValue = (days: number | 'keep'): string => keptWords(days).replace(/[.]$/, '')

/**
 * What is collected, as a page of Settings: the same rows as everywhere else, read only. A short sentence,
 * one group for each kind of data (its plain title, what is recorded, an example, how long it is kept, how
 * many records there are), then what is never recorded and where it is kept. No field name and no raw
 * row until the person asks for the recent records.
 */
export function CollectedPage({
	api,
	row,
	onBack,
}: { api: Api; row: ExtensionRow; onBack: () => void }) {
	const [notice, setNotice] = useState<ExtensionNotice>()
	const [counts, setCounts] = useState<Map<string, number>>()
	const [recent, setRecent] = useState<{ kind: string; table: ReturnType<typeof rowsTable> }>()
	const [error, setError] = useState<string>()
	useEffect(() => {
		let live = true
		void (async () => {
			const n = await ask(api, 'namzu/extensions/notice', { id: row.id })
			if (live && n.ok) setNotice(readNotice(n.value) ?? undefined)
			if (!row.running) return
			const c = await ask(api, 'namzu/extensions/query', { id: row.id, query: 'counts' })
			if (!live) return
			if (c.ok) setCounts(kindCounts(c.value))
			else setError(c.failure ? failureWords(c.failure) : undefined)
		})()
		return () => {
			live = false
		}
	}, [api, row.id, row.running])
	const showRecent = async (kind: string) => {
		const r = await ask(api, 'namzu/extensions/query', {
			id: row.id,
			query: 'rows',
			params: { kind },
		})
		if (r.ok) setRecent({ kind, table: rowsTable(r.value) })
		else setError(r.failure ? failureWords(r.failure) : undefined)
	}
	return (
		<CollectedView
			row={row}
			disclosure={notice?.disclosure}
			counts={counts}
			recent={recent}
			error={error}
			onBack={onBack}
			onShowRecent={(kind) => void showRecent(kind)}
		/>
	)
}

/** The page itself, from what was read: no request is made here, so it is drawn the same in a test. */
export function CollectedView({
	row,
	disclosure: d,
	counts,
	recent,
	error,
	onBack,
	onShowRecent,
}: {
	row: ExtensionRow
	disclosure: ExtensionDisclosure | undefined
	counts: ReadonlyMap<string, number> | undefined
	recent: { kind: string; table: ReturnType<typeof rowsTable> } | undefined
	error: string | undefined
	onBack: () => void
	onShowRecent: (kind: string) => void
}) {
	return (
		<div className="extension-screen" data-extension={row.id} data-page="collected">
			<header className="settings-page-header extension-screen-header">
				<div>
					<h1>
						<Button
							variant="ghost-muted"
							size="icon"
							className="extension-back"
							aria-label={`Back to ${row.name}`}
							onClick={onBack}
						>
							<ArrowLeftIcon aria-hidden="true" />
						</Button>
						What is collected
					</h1>
					<p className="extension-screen-sub">
						{d && d.dataKinds.length === 0
							? `${row.name} records nothing.`
							: `This is what ${row.name} records on this computer, and how long it keeps it.`}
					</p>
				</div>
			</header>
			{!d && <p className="extension-empty-line">Reading…</p>}
			<Failure failure={error} />
			{d?.dataKinds.map((k) => (
				<section key={k.id} data-kind={k.id}>
					<h2 className="settings-section-title">{kindTitle(k)}</h2>
					{!titleSaysAll(k) && (
						<Row
							id={`collected-${k.id}-what`}
							label="What it records"
							description={k.description}
						/>
					)}
					{k.example && (
						<Row id={`collected-${k.id}-example`} label="For example">
							<span className="settings-value extension-value">{k.example}</span>
						</Row>
					)}
					<Row id={`collected-${k.id}-kept`} label="How long it is kept">
						<span className="settings-value extension-value">{keptValue(k.retentionDays)}</span>
					</Row>
					<Row id={`collected-${k.id}-count`} label="Records">
						<span className="settings-value extension-value">
							{row.running ? recordCountWords(counts?.get(k.id)) : 'Counted while it is on'}
						</span>
					</Row>
					{row.running && (
						<Row id={`collected-${k.id}-recent`} label="Recent records">
							<Button variant="outline" size="sm" onClick={() => onShowRecent(k.id)}>
								Show recent records
							</Button>
						</Row>
					)}
					{recent?.kind === k.id && recent.table && (
						<div className="extension-rows">
							<div className="extension-rows-scroll">
								<table>
									<thead>
										<tr>
											{recent.table.columns.map((c) => (
												<th key={c}>{k.fields.find((f) => f.name === c)?.description ?? c}</th>
											))}
										</tr>
									</thead>
									<tbody>
										{recent.table.rows.map((r, i) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
											<tr key={i}>
												{r.map((v, j) => (
													// biome-ignore lint/suspicious/noArrayIndexKey: cells have no identity
													<td key={j}>{v}</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</div>
					)}
				</section>
			))}
			{d && d.doesNotCollect.length > 0 && (
				<section data-group="never">
					<h2 className="settings-section-title">Never recorded</h2>
					{d.doesNotCollect.map((t, i) => (
						<Row key={t} id={`collected-never-${i}`} label={t.replace(/[.;\s]+$/, '')} />
					))}
				</section>
			)}
			{d && d.dataKinds.length > 0 && (
				<section data-group="where">
					<h2 className="settings-section-title">Where it is kept</h2>
					<Row
						id="collected-where"
						label={d.storage.where.replace(/[.\s]+$/, '')}
						description={d.storage.encryption}
					/>
					{d.storage.adminCanRead && (
						<Row
							id="collected-admin"
							label="An administrator of this computer can get around this protection"
						/>
					)}
				</section>
			)}
			<p className="extension-footnote">
				This page only shows what is kept. There is no edit, export or delete here.
			</p>
		</div>
	)
}
