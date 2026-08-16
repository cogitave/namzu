/**
 * The direction reverses here.
 *
 * Everything else under `connector/mcp/` is **this process calling
 * somebody else's server**: `client.ts` opens the connection, `stdio.ts`
 * / `http-sse.ts` / `streamable-http.ts` carry it, `discovery.ts` asks
 * what is on the other end, `adapter.ts` turns what came back into tools.
 * A reader can assume that of any file in the directory and be right.
 *
 * This subdirectory is the opposite: **somebody else's client calling
 * ours.** `MCPServer` receives requests and answers them, and
 * `ServerStdioTransport` is the pipe it is spoken to over — the mirror of
 * `stdio.ts`, not a variant of it.
 *
 * They were siblings, distinguished only by the word `server` in two
 * filenames out of twelve, in a directory where every other name is also
 * about a server — the one being called. `MCPServerToolProvider` is a
 * thing a HOST implements to expose its tools to a caller, while
 * `MCPServerId` two files over identifies a remote server this process
 * connects to. Same prefix, opposite ends of the wire.
 *
 * A directory is the cheapest place to say that, and the only one a
 * reader consults before opening a file.
 */

export { MCPMethodNotFound, MCPServer } from './server.js'
export type {
	MCPServerPromptProvider,
	MCPServerResourceProvider,
	MCPServerToolProvider,
} from './server.js'
export { ServerStdioTransport } from './server-stdio.js'
