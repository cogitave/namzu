---
"@namzu/desktop": patch
---

The Windows installer built by the release workflow now carries the light Pal computer image, so a Pal's computer needs no download. The workflow checks the image's identity before it ships and fails if the image is missing from the installer; a `dry_run` dispatch builds without publishing.
