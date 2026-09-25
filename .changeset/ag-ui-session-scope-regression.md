---
'@namzu/ag-ui': patch
---

Exercise repeated AG-UI runs with one stable native session owner and verify that a host resolving the same session under another tenant is refused before its history reaches a model. This updates the integration checks for the SDK's stricter session attribution; the adapter API is unchanged.
