/**
 * The code index's parsing child, as an entry of the CLI's own bundle.
 *
 * `@namzu/analysis` forks a child process to parse, so that a native parser
 * crash costs one file instead of the terminal. The package is bundled into
 * the CLI (it is not on the registry on its own), so the child script has to
 * ship in the CLI's `dist` too: this file is that script, built as the entry
 * `dist/analysis-host.js`. Importing the package's host module is all it does;
 * the module starts the child loop when it finds it was forked.
 */
import '@namzu/analysis/indexer-host'
