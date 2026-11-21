---
"@namzu/cli": patch
---

Extensions signed by Cogitave can be added: the build now trusts Cogitave's production publisher key (`cogitave-2026`, for ids starting with `com.cogitave.`). Before, a release build trusted no publisher and refused every package. Packages from any other key are still refused, and a developer key still needs `NAMZU_EXTENSION_DEV=1` with `NAMZU_EXTENSION_TEST_PUBLIC_KEY`.
