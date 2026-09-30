/** Isolated presentation reference. Originals are copied from the pinned checkout at run time. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowUpIcon, FileDiffIcon, FolderIcon, FolderPlusIcon, MoonIcon, SearchIcon, SquarePenIcon, TerminalIcon } from 'lucide-react'
import { ComposerSurface } from './original/ComposerSurface'
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from './original/ComposerControl'
import { WorkspacePageHeader } from './original/WorkspacePageHeader'
import { Button } from './original/button'
import { CpuIcon } from 'lucide-react'
import './original/index.css'
const data = window.referenceData
function App() {
 return <div className="grid h-full grid-cols-[256px_minmax(0,1fr)]">
  <aside data-app-sidebar className="flex min-h-0 flex-col bg-sidebar">
   <div className="relative flex h-(--workspace-topbar-height) shrink-0 items-center gap-2 px-4 text-sm font-medium">T3 Code</div>
   <div className="relative flex w-full min-w-0 flex-col p-(--sidebar-content-inset)">
    <div className="flex items-center gap-1">
     <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"><SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" /><span>Search</span></div>
     <Button size="icon-sm" variant="ghost-muted" className="relative size-7 shrink-0"><FolderIcon /></Button><Button size="icon-sm" variant="ghost-muted" className="relative size-7 shrink-0"><FolderPlusIcon /></Button><Button size="icon-sm" variant="ghost-muted" className="relative size-7 shrink-0"><SquarePenIcon /></Button>
    </div>
   </div>
   <div className="min-h-0 flex-1 overflow-y-auto p-(--sidebar-content-inset) pt-0">
    <ul><li className="list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_78px]">
     <button type="button" data-ref="card" className="group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring bg-sidebar-row-active text-sidebar-foreground">
      <div className="relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
       <div className="flex h-5 min-w-0 items-center gap-1.5"><FolderIcon className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate text-secondary-label text-xs font-medium">{data.project}</span><span className="text-xs text-secondary-label">now</span></div>
       <div className="mt-1 flex min-w-0"><span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90 transition-opacity motion-reduce:transition-none">{data.title}</span></div>
       <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs"><span className="min-w-0 flex-1 truncate text-muted-foreground/40">Local conversation</span></div>
      </div>
     </button>
    </li></ul>
   </div>
   <div className="flex h-10 items-center px-2"><Button size="icon-sm" variant="ghost-muted"><MoonIcon /></Button><Button size="icon-sm" variant="ghost-muted"><FolderPlusIcon /></Button></div>
  </aside>
  <main className="flex min-h-0 min-w-0 flex-col bg-background">
   <WorkspacePageHeader data-ref="header"><div className="flex min-w-0 flex-1 items-center gap-2 text-xs"><span className="text-muted-foreground">{data.project}</span><span className="text-muted-foreground">/</span><strong className="truncate font-medium">{data.title}</strong></div><Button variant="ghost-muted" size="sm"><TerminalIcon />Background work</Button><Button variant="ghost-muted" size="icon-sm"><FileDiffIcon /></Button></WorkspacePageHeader>
   <div className="relative flex min-h-0 flex-1 flex-col">
    <div data-ref="transcript" className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto px-3 pt-5 sm:px-5" style={{paddingBottom:data.composerHeight+16}}>
     <div className="mx-auto w-full min-w-0 max-w-(--chat-max-width) overflow-x-clip">
      {data.messages.map((message, index) => <div key={index} className="pb-4">
       {message.role === 'user' ? <div className="group flex flex-col items-end gap-1"><div data-ref="user" className="relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground"><div className="whitespace-pre-wrap text-sm leading-relaxed">{message.text}</div></div></div> : <div className="relative min-w-0 px-1 py-0.5"><div data-ref="assistant" className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80 [overflow-wrap:anywhere] [word-break:break-word]" dangerouslySetInnerHTML={{__html: message.html}} /></div>}
      </div>)}
     </div>
    </div>
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2">
     <div className="w-full ps-(--workspace-gutter-start) pe-(--workspace-gutter-end)">
      <div className="group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-max-width)">
       <ComposerSurface.Shell contextStrip>
        <ComposerSurface.Host><ComposerSurface.Main>
         <div data-ref="composer-body" className="relative px-3 pb-2 pt-3.5 sm:px-4 sm:pt-4"><div data-ref="editor" className="composer-tiptap -m-1 block max-h-52 min-h-19.5 overflow-y-auto p-1 whitespace-pre-wrap wrap-break-word bg-transparent leading-relaxed text-foreground focus:outline-none text-sm">{data.draft}</div></div>
         <div data-ref="footer" className="flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4 sm:gap-0">
          <div className="relative -m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"><ComposerControl data-ref="model"><ComposerControlIcon icon={CpuIcon} /><span>{data.model}</span><ComposerControlChevron /></ComposerControl></div>
          <div className="flex shrink-0 flex-nowrap items-center justify-end gap-2"><button type="button" data-ref="send" className="relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-2xs enabled:inset-shadow-white/16 hover:scale-105 active:inset-shadow-black/8 active:shadow-none disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover"><ArrowUpIcon className="size-3.5" /></button></div>
         </div>
        </ComposerSurface.Main></ComposerSurface.Host>
        <ComposerSurface.ContextStrip><ComposerControl size="xs" render={<span />}><FolderIcon className="size-3.5" /><span>{data.project}</span></ComposerControl><span className="ml-auto pe-1 text-xs text-muted-foreground/50">Local</span></ComposerSurface.ContextStrip>
       </ComposerSurface.Shell>
       <div className="h-4 sm:h-5" />
      </div>
     </div>
    </div>
   </div>
  </main>
 </div>
}
createRoot(document.getElementById('root')).render(<App />)
