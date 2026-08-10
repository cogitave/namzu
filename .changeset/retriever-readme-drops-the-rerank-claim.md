---
'@namzu/sdk': patch
---

The README no longer promises reranking the retriever does not implement

`README.md` described `rag/retriever.ts` as "the retrieval query path with
configurable top-k, threshold, and reranking". There is no rerank stage and
never was: no field on `RetrievalConfig`, no member in
`DEFAULT_RETRIEVAL_CONFIG`, no method on the `Retriever` interface, and no
stage in `DefaultRetriever.retrieve`, which runs vector, keyword (BM25) or
hybrid search and slices to `topK`. `rerank` appeared exactly once in the
repository, in that sentence.

Nothing errors when a reader configures for it, because there is no setting to
set — you simply receive first-stage results and believe they were reranked.
The line now describes what the file does and says outright that there is no
rerank stage. This is a documentation fix; no behaviour changes.

The capability is a reasonable thing to want and is deliberately not built
here. Published results include cases where a reranker scores *below* the
first stage, so it wants a retrieval eval beside it rather than an assumption
that adding one is an improvement.
