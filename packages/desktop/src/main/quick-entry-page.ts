/** Where the Quick Entry box's script talks to main: the preload exposes these two calls. */
export const QUICK_ENTRY_SUBMIT = 'namzu:quick-entry-submit'
export const QUICK_ENTRY_CANCEL = 'namzu:quick-entry-cancel'

/** The size of the box. One line to type in, nothing else. */
export const QUICK_ENTRY_SIZE = { width: 560, height: 64 } as const

/** The Quick Entry box: one line. Enter starts a conversation with it; Escape closes the box. */
export function quickEntryPage(): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Namzu Quick Entry</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1d1d1f;--line:#c9c9ce;--hint:#6e6e73}
@media (prefers-color-scheme:dark){:root{--bg:#1e1e20;--fg:#f2f2f4;--line:#3d3d42;--hint:#9a9aa0}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:15px system-ui,sans-serif;overflow:hidden}
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
export function quickEntryUrl(): string {
	return `data:text/html;charset=utf-8,${encodeURIComponent(quickEntryPage())}`
}
