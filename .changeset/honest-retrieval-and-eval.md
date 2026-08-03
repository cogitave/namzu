---
'@namzu/sdk': patch
---

Fix five defects in the eval harness and RAG retrieval — all plain bugs
with correct answers, not design trade-offs.

**Eval harness — it could report green on a broken suite.**

- A case whose run THREW scored 1.0. `executeCase` catches the failure and
  returns an empty run, and an empty run walks into every scorer's happy
  path: `stepBudgetScorer` sees 0 steps against its allowance and returns
  1, `trajectoryScorer` sees "no tools expected, none called" and returns
  1. The failure was recorded on `run.error` and nothing consulted it. Any
  run that failed now scores 0, with the error as the reason.
- Two scorers sharing a name silently collapsed. Scores are keyed by name,
  so a second `containsScorer(...)` — also called `contains` — overwrote
  the first, and the case mean's denominator became the count of distinct
  NAMES rather than scorers run. With one scoring 0 and one scoring 1 the
  suite reported 1.0 where the honest answer is 0.5. Duplicate names now
  throw.

**RAG retrieval.**

- `bm25Score` implemented only the term-frequency saturation half and no
  IDF at all — the half that discriminates. Without it every matched term
  weighs the same, so a chunk matching three common words outranks the one
  chunk containing the rare term the query was about. It also normalized
  document length against a hardcoded `avgDl = 256` rather than the corpus
  in front of it. Both now computed from the candidate set.
- `hybridSearch` blended bounded cosine with unbounded BM25 linearly, so
  `hybridAlpha` did not weight the two halves — whichever scale happened to
  be larger won. Each ranking is normalized to [0,1] first.
- The recursive chunker used `text.split(sep)`, which DELETES the
  separator: splitting on `'. '` stripped every sentence terminator and
  `'\n\n'` stripped every paragraph break, so the chunk shown to the model
  was not what the document said.
