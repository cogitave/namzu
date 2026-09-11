---
"@namzu/sdk": minor
---

Add opt-in resident initiative APIs: `createResidentSelector`, host `select`/`observe` options, atomic observed settlement and selection-bound admission in `DiskResidentAgenda`. Hosts can retain verified progress and measured costs, inspect selection reasons and abstain without model calls. The experimental selector can stop before delayed payoffs and provides no general performance or starvation guarantee; the default fair host policy is unchanged.

Add bounded `ResidentProposal` validation and atomic `admitProposal` with parent revision checks, domain allowlists, child/depth limits and durable deduplication. Domain metadata does not authorize tools or prove semantic scope; hosts still validate objectives and bind existing execution controls. No CLI defaults, always-on services or external messages are enabled.

Agenda schema 2 stores optional feedback and proposal ancestry. Existing schema-1 agendas remain readable without invented observations; older SDK writers refuse new records to prevent data loss. Alternative agenda backends can opt into `executionAt` and `settleObserved`; hosts reject configured extensions when their atomic storage support is absent.
