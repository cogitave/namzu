import { Globe } from 'lucide-react'
import type { LinkPreviewDetails } from './link-preview-parse.js'
import { useLinkPreview } from './link-preview-store.js'
import './link-preview.css'

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '')
	} catch {
		return url
	}
}

/** Where the link goes, as a reader would say it: no protocol, no trailing slash. */
function addressOf(url: string): string {
	try {
		const parsed = new URL(url)
		let path = parsed.pathname
		try {
			path = decodeURI(path)
		} catch {}
		path = path.replace(/\/+$/, '')
		return `${parsed.hostname.replace(/^www\./, '')}${path}`
	} catch {
		return url
	}
}

function titleOf(url: string, text: string, details?: LinkPreviewDetails): string {
	if (details?.title) return details.title
	const label = text.trim()
	if (label && label !== url && label !== addressOf(url)) return label
	return hostOf(url)
}

function SiteRow({ url, icon, siteName }: { url: string; icon?: string; siteName?: string }) {
	return (
		<div className="flex min-w-0 items-center gap-1.5">
			{icon ? (
				<img alt="" className="size-4 shrink-0 rounded-[4px]" height={16} src={icon} width={16} />
			) : (
				<Globe aria-hidden="true" className="shrink-0 text-muted-foreground" size={14} />
			)}
			<span className="truncate text-muted-foreground text-xs">{siteName ?? hostOf(url)}</span>
		</div>
	)
}

/**
 * The card for one link. It only mounts while the card is open, so the page
 * is requested on demand. A missing preview shows the address alone — never
 * an error — and the final content fades in once, complete.
 */
export function LinkPreviewCard({
	url,
	text,
	onOpen,
}: { url: string; text: string; onOpen: (url: string) => void }) {
	const { phase, result } = useLinkPreview(url)
	const ready = result?.status === 'ready' ? result : undefined
	const details = ready?.details
	const address = addressOf(url)
	return (
		<button
			className="block w-80 max-w-(--available-width) cursor-pointer overflow-hidden rounded-lg border-0 bg-popover p-0 text-left text-popover-foreground outline-none"
			data-phase={phase}
			data-slot="link-preview-card"
			onClick={() => onOpen(url)}
			type="button"
		>
			{phase === 'loading' && (
				// Reserve the picture's place so the card does not resize, and flip
				// sides, when the details arrive.
				<span
					aria-hidden="true"
					className="block aspect-[1.91/1] w-full animate-pulse bg-foreground/6 motion-reduce:animate-none"
				/>
			)}
			{ready?.image && (
				<img
					alt=""
					className="link-preview-fade block aspect-[1.91/1] w-full object-cover"
					src={ready.image}
				/>
			)}
			<span
				// Only the placeholder holds a height; a finished card fits its content.
				className={`${phase === 'loading' ? 'min-h-[7.25rem] ' : 'link-preview-fade '}flex flex-col gap-1.5 p-3`}
			>
				<SiteRow icon={ready?.icon} siteName={details?.siteName} url={url} />
				<span className="line-clamp-2 font-medium text-sm leading-snug">
					{titleOf(url, text, details)}
				</span>
				{phase === 'loading' && (
					<span aria-hidden="true" className="flex flex-col gap-1.5 pt-0.5">
						<span className="block h-2.5 w-full animate-pulse rounded bg-foreground/8 motion-reduce:animate-none" />
						<span className="block h-2.5 w-[70%] animate-pulse rounded bg-foreground/8 motion-reduce:animate-none" />
					</span>
				)}
				{details?.description && (
					<span className="line-clamp-3 text-muted-foreground text-xs leading-relaxed">
						{details.description}
					</span>
				)}
				<span className="mt-auto truncate text-muted-foreground/80 text-xs">{address}</span>
			</span>
		</button>
	)
}
