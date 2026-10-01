/** Isolated presentation reference. Originals are copied from the pinned checkout at run time. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowUpIcon, FileDiffIcon, FolderIcon, FolderPlusIcon, MoonIcon, SearchIcon, SquarePenIcon, TerminalIcon, PanelLeftIcon } from 'lucide-react'
import { ComposerSurface } from './original/ComposerSurface'
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from './original/ComposerControl'
import { WorkspacePageHeader } from './original/WorkspacePageHeader'
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem, WorkspaceBreadcrumbSeparator, WorkspaceBreadcrumbText } from './original/WorkspaceBreadcrumb'
import { Button } from './original/button'
import { HeaderBackdrop } from './original/HeaderBackdrop'
import { ComposerBanner } from './original/ComposerBanner'
import { ComposerPendingApprovalPanel } from './original/ComposerPendingApprovalPanel'
import { applyAppearanceFontVariables } from './original/appearanceFonts'
import { DEFAULT_CODE_FONT_SIZE, DEFAULT_INTERFACE_FONT_SIZE, DEFAULT_PROMPT_FONT_SIZE } from './original/font-defaults'
import { CpuIcon } from 'lucide-react'
import './original/index.css'
const data = window.referenceData
applyAppearanceFontVariables(document.documentElement, {sans:'',code:'',composer:'',sizeInterface:DEFAULT_INTERFACE_FONT_SIZE,sizePrompt:DEFAULT_PROMPT_FONT_SIZE,sizeCode:DEFAULT_CODE_FONT_SIZE,smoothing:true})
function App() {
 return <div className="grid h-full" style={{gridTemplateColumns: data.collapsed ? "0 minmax(0,1fr)" : "256px minmax(0,1fr)"}}>
  <aside data-app-sidebar className="relative flex min-h-0 w-64 flex-col bg-sidebar" style={{visibility:data.collapsed ? "hidden" : undefined}}>
   <div data-ref="sidebar-chrome" className="@container/sidebar-header relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 px-3 md:px-0">
    <HeaderBackdrop />
    <Button data-ref="sidebar-toggle" className="relative z-10 ml-3" variant="ghost-muted" size="icon-sm"><PanelLeftIcon /></Button>
    <div className="relative z-10 flex h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md text-white"><span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">T3 Code</span></div>
   </div>
   <div className="relative z-[1] flex w-full min-w-0 flex-col p-(--sidebar-content-inset)">
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
   <WorkspacePageHeader data-ref="header"><WorkspaceBreadcrumb ariaLabel="Conversation breadcrumb" className="flex-1 overflow-clip [overflow-clip-margin:2px]"><WorkspaceBreadcrumbItem className="shrink"><WorkspaceBreadcrumbText className="max-w-40" data-project-label>{data.project}</WorkspaceBreadcrumbText></WorkspaceBreadcrumbItem><WorkspaceBreadcrumbSeparator><WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText></WorkspaceBreadcrumbSeparator><WorkspaceBreadcrumbItem current className="min-w-10 flex-1"><h2 className="min-w-0 flex-1"><WorkspaceBreadcrumbText data-conversation-title>{data.title}</WorkspaceBreadcrumbText></h2></WorkspaceBreadcrumbItem></WorkspaceBreadcrumb><Button variant="ghost-muted" size="sm"><TerminalIcon />Background work</Button><Button variant="ghost-muted" size="icon-sm"><FileDiffIcon /></Button></WorkspacePageHeader>
   <div className="relative flex min-h-0 flex-1 flex-col">
    <div data-ref="transcript" className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto px-3 pt-5 sm:px-5" style={{paddingBottom:data.composerHeight+16}}>
     <div className="mx-auto w-full min-w-0 max-w-(--chat-max-width) overflow-x-clip">
      {data.timeline.map((message, index) => message.kind === 'tool' ? <div key={index} className="pb-2"><div data-ref="tool" className="group/timeline-row relative flex flex-col rounded-md px-0.5 transition-colors py-0.5"><div className="flex select-none items-center gap-1.5 transition-[opacity,translate] duration-200 text-sm leading-relaxed text-muted-foreground"><span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">{message.icon === 'terminal' ? <TerminalIcon className="size-4" /> : <FileDiffIcon className="size-4" />}</span><span data-ref="toolLabel" className="min-w-0 flex-1 text-secondary-label">{message.title}</span><span className="text-[11px] opacity-60">{message.status}</span></div></div></div> : <div key={index} className="pb-4">
       {message.role === 'user' ? <div className="group flex flex-col items-end gap-1"><div data-ref="user" className="relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground"><div className="whitespace-pre-wrap text-sm leading-relaxed">{message.text}</div></div></div> : <div className="relative min-w-0 px-1 py-0.5"><div data-ref="assistant" className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80 [overflow-wrap:anywhere] [word-break:break-word]" dangerouslySetInnerHTML={{__html: message.html}} /></div>}
      </div>)}
     </div>
    </div>
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2">
     <div className="w-full ps-(--workspace-gutter-start) pe-(--workspace-gutter-end)">
      <div className="group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-max-width)">
       <ComposerSurface.Shell contextStrip>
        {data.approval && <ComposerBanner.Dock><ComposerBanner.Column><ComposerBanner.Attachment><ComposerBanner.Root variant="warning" density="spacious"><ComposerBanner.Row layout="approval"><ComposerBanner.Icon><FolderIcon /></ComposerBanner.Icon><ComposerBanner.Content><ComposerPendingApprovalPanel approval={{requestKind:"command",detail:data.approval.summary}} pendingCount={data.approval.count} /></ComposerBanner.Content><ComposerBanner.Actions><Button size="xs" variant="outline">Decline</Button><Button size="xs">Allow once</Button></ComposerBanner.Actions></ComposerBanner.Row></ComposerBanner.Root></ComposerBanner.Attachment></ComposerBanner.Column></ComposerBanner.Dock>}
        <ComposerSurface.Host><ComposerSurface.Main>
         <div data-ref="composer-body" className={`relative px-3 sm:px-4 ${data.resting ? "py-2 sm:py-2 pe-14 sm:pe-14" : "pb-2 pt-3.5 sm:pt-4"}`}><div data-ref="editor" className={`composer-tiptap block bg-transparent text-foreground focus:outline-none text-sm ${data.resting ? "my-0 max-h-8 min-h-8 overflow-hidden py-0 whitespace-pre! leading-8" : `-m-1 max-h-52 ${data.approval ? "min-h-10" : "min-h-19.5"} overflow-y-auto p-1 whitespace-pre-wrap wrap-break-word leading-relaxed`}`}>{data.draft || <span className="text-placeholder/75">{data.placeholder}</span>}</div></div>
         {!data.approval && <div data-ref="footer" className={`flex min-w-0 flex-nowrap items-center justify-between overflow-visible px-3 sm:px-4 ${data.resting ? "absolute bottom-px right-px z-10 h-12 w-auto gap-0 py-0 sm:gap-0 sm:py-0" : "gap-2 pb-3 sm:pb-4 sm:gap-0"}`}>
          {!data.resting && <div className="relative -m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"><ComposerControl data-ref="model"><ComposerControlIcon icon={CpuIcon} /><span>{data.model}</span><ComposerControlChevron /></ComposerControl></div>}
          <div className="flex shrink-0 flex-nowrap items-center justify-end gap-2"><button type="button" data-ref="send" className="relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-2xs enabled:inset-shadow-white/16 hover:scale-105 active:inset-shadow-black/8 active:shadow-none disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover"><ArrowUpIcon className="size-3.5" /></button></div>
         </div>}
        </ComposerSurface.Main></ComposerSurface.Host>
        <ComposerSurface.ContextStrip>{data.resting && <div className="min-w-0 max-w-[60%]"><ComposerControl data-ref="model"><ComposerControlIcon icon={CpuIcon} /><span>{data.model}</span><ComposerControlChevron /></ComposerControl></div>}<ComposerControl size="xs" render={<span />}><FolderIcon className="size-3.5" /><span>{data.project}</span></ComposerControl><span className="ml-auto pe-1 text-xs text-muted-foreground/50">Local</span></ComposerSurface.ContextStrip>
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
