---
"@namzu/sandbox": patch
---

Adds an internal Kubernetes API client (`backends/kubernetes/k8s-client.ts`, not yet exported from the package entrypoint) for an in-progress Kubernetes/Kata sandbox backend. It speaks the API server with bare `fetch`, falling back to `node:https` only when a custom cluster CA is supplied, and bootstraps in-cluster credentials straight from the projected ServiceAccount volume — the same zero-dependency pattern the ACI and Firecracker backends already use. `@namzu/sandbox` still declares no `dependencies` key.
