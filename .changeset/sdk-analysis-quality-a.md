---
'@namzu/sdk': minor
---

The `code_analysis` tool prints compactly and carries what `@namzu/analysis` now knows. Fifty `find_literal` hits on a 2,434-file bundle go from about 5.6k tokens to about 1k: paths are relative to the root and printed once per file, a function is `Svc.init#12 L10-40`, and text-only or `call/apply/bind` callers are labelled. Anything that parsed the old text lines (`path:line:col  kind "value" in name [kind, id N] path…`) needs the new shape; the structured `data` is unchanged except for the additions below.

Additive, but two result unions are wider, so an exhaustive `switch` over them needs a new arm: `AnalysisCallSite.kind` gains `'call-via'` and `'tagged'`, and an export `AnalysisModuleEdge.kind` gains `'type'`, `'commonjs'` and `'assign'`. New optional fields: `AnalysisFunction.qualifiedName`, `AnalysisCallSite.resolution`, `AnalysisSourceSlice.window`, `AnalysisEnclosingFunction.inClass`, `FunctionSourceRequest.around`. The tool's `function_source` takes `line` and `column` to cut a long function around that position, and `callers_of` accepts `Class.method`.
