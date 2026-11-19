import type { WindowAppearance } from '../shared/protocol.js'

/** Where the Quick Entry box's script talks to main: the preload exposes these two calls. */
export const QUICK_ENTRY_SUBMIT = 'namzu:quick-entry-submit'
export const QUICK_ENTRY_CANCEL = 'namzu:quick-entry-cancel'

/** The size of the box. One line to type in, nothing else. */
export const QUICK_ENTRY_SIZE = { width: 560, height: 64 } as const

/** The app's own colours (theme.css `:root` and `.dark`) for the two looks the box can wear. */
const PALETTE: Readonly<
	Record<WindowAppearance, { bg: string; fg: string; line: string; hint: string }>
> = {
	light: { bg: '#ffffff', fg: '#27272a', line: '#e4e4e7', hint: '#71717b' },
	dark: { bg: '#181818', fg: '#f5f5f5', line: '#3a3a3a', hint: '#979797' },
}

export interface QuickEntryLook {
	/**
	 * The look the main window has now, light or dark: the choice already resolved, so System is
	 * what the device says. Dark until a window has said otherwise, as the app itself starts.
	 */
	appearance?: WindowAppearance
	/** The app's own face as a data address, so the box reads in the same font as the window. */
	fontData?: string
}

/** The Quick Entry box: one line. Enter starts a conversation with it; Escape closes the box. */
export function quickEntryPage(look: QuickEntryLook = {}): string {
	const appearance = look.appearance === 'light' ? 'light' : 'dark'
	const colors = PALETTE[appearance]
	const face = look.fontData
		? `@font-face{font-family:"Geist";font-weight:100 900;src:url("${look.fontData}") format("woff2")}`
		: ''
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Namzu Quick Entry</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="${appearance}">
<style>
${face}
:root{color-scheme:${appearance};--bg:${colors.bg};--fg:${colors.fg};--line:${colors.line};--hint:${colors.hint}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:15px "Geist",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;overflow:hidden}
body{box-sizing:border-box;border:1px solid var(--line);border-radius:12px;display:flex;align-items:center;padding:0 16px}
input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:inherit;font:inherit}
input::placeholder{color:var(--hint)}
</style></head><body>
<input id="line" type="text" autocomplete="off" spellcheck="true" maxlength="4000"
 aria-label="Start a conversation" placeholder="Ask Namzu something, then press Enter">
<script>
const line=document.getElementById('line')
line.focus()
addEventListener('keydown',(event)=>{
 if(event.key==='Escape'){event.preventDefault();window.quickEntry.cancel();return}
 if(event.key==='Enter'&&!event.isComposing&&!event.shiftKey){event.preventDefault();window.quickEntry.submit(line.value)}
})
</script></body></html>`
}

/** The page as a data address, the way the recovery card is loaded. */
export function quickEntryUrl(look: QuickEntryLook = {}): string {
	return `data:text/html;charset=utf-8,${encodeURIComponent(quickEntryPage(look))}`
}
