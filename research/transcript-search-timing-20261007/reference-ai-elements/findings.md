# Transcript reference observations — 2026-10-07

Read-only live Chromium audit: 1440 × 1000, dark theme, browser zoom 1. Seven primary documentation pages, 16 recorded interaction states. Real DOM, computed CSS and animation keyframes are in [receipt.json](receipt.json). [capture.mjs](capture.mjs) records the public pages without installing components or changing product files. Four associated AI Elements source files were retrieved at commit `6a9d5b1822ffb10bba4bd97175f01edd7d8651cd`; their immutable URLs and hashes are in the receipt. Raw sources stay in a task cache under `/tmp`, rather than being vendored into this repository. Upstream [LICENSE](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/LICENSE) identifies Apache-2.0, Copyright 2023 Vercel, Inc. The capture keeps that source revision pinned for reproducibility; live documentation can change independently.

## Findings

| Reference | What is visible when closed | What opening reveals | Verified hierarchy |
| --- | --- | --- | --- |
| [Chain of Thought](https://elements.ai-sdk.dev/components/chain-of-thought) | One muted subject header and chevron; 20 px high in this example. | Distinct natural action sentences, domain chips, an image with caption, and a brief description. | 14/20 px labels, 16 px topic icons, 8 px icon/text gap; secondary domain chips 12/16 px with 2 × 8 px padding. No raw query masquerades as a tool name in this example. |
| [Reasoning](https://elements.ai-sdk.dev/components/reasoning) | One thinking summary and chevron. | Reasoning prose; no second repeated subject/action header inside the body. | Stream starts open. In this live demo its measured summary became 3 seconds, then it closed about one second after completion. Source defines that 1,000 ms delay. Unknown duration has a generic fallback in the reference; that fallback is not a measured local duration. |
| [Sources](https://elements.ai-sdk.dev/components/sources) | A count summary, 16 px high in this example. | Three titled external links with book icons. | 12/16 px summary/links, 16 px icons, 8 px spacing; links open externally with noreferrer. Source titles carry the useful identity rather than full raw URLs. |
| [Tool](https://elements.ai-sdk.dev/components/tool) | One action identifier, state badge and chevron. | Parameter code, result/error body and optional confirmation. | Subject icon 16 px; status icon resolves to 12 px inside the badge. Main title uses 14 px medium text; status is 12/16 px. Explicit `title` overrides the technical derived identifier. This example remains intentionally technical and should not be copied wholesale for Namzu's ordinary user view. |
| [shadcn Item](https://ui.shadcn.com/docs/components/base/item) | A primary title, optional muted description, optional media and trailing action. | Item itself is a content container, not an automatic disclosure. | Title 14 px/weight 500; description 14 px/21 px/weight 400. Content flexes; actions align at the right. Default and small examples use 10 × 12 px padding; extra small uses 8 × 10 px and tighter gap. |
| [shadcn Badge](https://ui.shadcn.com/docs/components/base/badge) | A compact secondary label. | No separate expanded state. | All four demonstrated variants are 12/16 px, weight 500, 2 × 8 px padding. Secondary and outline variants keep low priority information visually quiet. |
| [shadcn Collapsible](https://ui.shadcn.com/docs/components/base/collapsible) | Order title and meaningful state; one disclosure control. | Address/items, without repeating the order title. | Base UI implementation; `aria-expanded` reflects actual open state. This docs preview has no measured content height animation; the button's hover transition is 150 ms. |

### Motion and accessibility evidence

- AI Elements chain/content close and sources/content open produced 150 ms CSS entry/exit animations. The source uses fade plus 8 px vertical slide; measured chevron/color transitions were 150 ms with `cubic-bezier(0.4, 0, 0.2, 1)`. Source code and actual animation timing are different evidence from a screenshot.
- The chain disclosure closed on click and reopened with keyboard Enter. Recorded controls have `aria-expanded` and `aria-controls`; decorative AI Elements icons are hidden from assistive technology. No captured example contains nested buttons.
- The reference pages emitted React hydration warning #418 during server/client handoff. The capture records those warnings, reacquires replaced nodes, and measures attached nodes. It does not claim that the upstream site is warning-free.
- Screenshots disable CSS animation only for settled static capture. Transition measurements are collected separately before that step. They do not prove Namzu's motion or reduced-motion behavior.

### Documentation/implementation difference

The Tool documentation claims completed tools open by default. The pinned `Tool` component only forwards Collapsible props, without a status-driven opening effect. In the live status preview the pending row is open and the completed/error rows start closed. The receipt records this initial state before manually opening the completed row. Choose the application's open policy explicitly; do not infer an automatic default from that sentence.

## Specific recommendations for Namzu

These are product proposals informed by the inspected references, not a universal industry standard.

1. Show one human action summary in a collapsed transcript row. Place the typed query, tool identifier and parameter data inside its detail region. Keep a query's typography subordinate to the subject; do not promote the query into the action's name.
2. Use a single disclosure owner for each action. Expanded content starts with the useful query/result or detail sections rather than a second identical clickable title. Preserve separate reasoning content and action results.
3. Group actual sources under a compact count summary and display recognisable titles/domains after opening. Use secondary chips for identities/counts and semantic icons for the kind of action. Prefer source links to a large JSON/code surface in normal research results.
4. Use the project's existing tokens around the observed 14 px subject / 12 px metadata hierarchy, 16 px subject icon and compact badge geometry. The 640/801 px widths in these captures are documentation preview widths, not recommended Namzu layout constants.
5. Reuse restrained disclosure motion with one chevron and a short content transition. Do not animate each historical/token update or add a second global working heading. Respect Namzu's established user-controlled open state and reduced-motion preference rather than adopting upstream auto-open/auto-close blindly.
6. The inspected components do not establish a message-clock hover pattern. A contextual clock/detail treatment would be Namzu's own decision; preserve the existing exact journal time and show elapsed duration only when actually measured. Do not label an unknown duration as zero or copy the reference's approximate fallback as a measurement.

## Visual evidence

- [Expanded action chain](chain-expanded.png) / [collapsed chain](chain-collapsed.png).
- [Reasoning stream](reasoning-streaming.png) / [finished body](reasoning-completed.png) / [automatically collapsed completion](reasoning-completed-auto-collapsed.png).
- [Sources closed](sources-collapsed.png) / [sources open](sources-expanded.png).
- [Technical tool details](tool-completed-expanded.png).
- [shadcn item](shadcn-item-basic.png), [compact badge variants](shadcn-badge-variants.png), [collapsible details](shadcn-collapsible-expanded.png).

Associated source links: [chain](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/chain-of-thought.tsx), [reasoning](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/reasoning.tsx), [sources](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/sources.tsx), [tool](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/tool.tsx).
