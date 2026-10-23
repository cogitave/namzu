---
'@namzu/sdk': minor
'@namzu/analysis': minor
'@namzu/cli': minor
---

The native binary lane moves out of the private `packages/analysis-native` into `@namzu/analysis`: the Rust sidecar (`namzu-analysis-native`), its TypeScript client and the asar reader, with new exports `createNativeAnalysisProvider`, `createNativeAnalysis`, `resolveSidecar` and `extractAsar`. `@namzu/sdk` declares the seam (`NativeAnalysisProvider`, `types/native-analysis`) and serves a new deferred `binary_analysis` tool — info, symbols, imports, exports and strings over a compiled binary; it is registered only when a host sets `QueryParams.nativeAnalysis`. `@namzu/cli` mounts the provider in the TUI (inert until the model's first call, parent session only) and `namzu doctor` gains `analysisNative.hello`, which runs the sidecar's hello once.
