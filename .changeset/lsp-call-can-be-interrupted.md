---
'@namzu/sdk': minor
'@namzu/lsp': minor
---

An `lsp` call now takes the turn's abort signal, so stopping a turn ends a
language-server request instead of leaving the turn waiting on it.

The four `CodeNavigationProvider` methods take an optional last argument,
`CodeNavigationRequestOptions` (`{ signal }`). Aborting it drops that request
from the pending table, sends the server `$/cancelRequest`, and answers with a
new `interrupted` arm, `{ kind: 'interrupted', reason }`, on
`CodeNavigationResult`, `HoverResult` and `SymbolSearchResult`.

That arm is added to the result unions, so a consumer that switches over all
three existing arms exhaustively needs one more. `interrupted` is deliberately
not `failed`: the server did nothing wrong, the next call still uses it, and
the answer is unknown only because nobody finished asking. It is deliberately
not an empty `locations`/`symbols` list either — that reads as "nothing uses
this", which is what a deletion is made on.

The `lsp` builtin passes `ToolContext.abortSignal` and returns a stopped turn
before starting a server at all; it reports an interrupted call as interrupted
and unknown rather than empty.

`StdioCodeNavigationProvider` also bounds a handshake against each caller's
signal. The start stays shared, so one caller's abort stops that caller
waiting and leaves the `initialize` to finish under its own startup timeout,
which still fails with the binary named and the timeout stated.