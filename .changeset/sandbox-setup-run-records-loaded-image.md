---
"@namzu/sandbox": patch
---

`runWslcSetup` now answers `{ outcome: 'ready' }` and records the image when the plan it was asked to run is gone only because the PC is already ready (the image was loaded before any record existed). It used to answer `plan-changed` and leave the record unwritten, so the next `inspectWslcReadiness` without a session probe still said `image-missing`. A caller that treated `plan-changed` as the only answer for that case now also sees `ready`; any other changed plan still answers `plan-changed`.
