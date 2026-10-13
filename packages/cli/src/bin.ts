#!/usr/bin/env node

import { fileURLToPath } from 'node:url'

// First, for its effect: the compile cache covers only the modules loaded after it.
import './compile-cache-enable.js'

// Then the filter, which must be in place before anything below can load
// `node:sqlite`.
import './warning-filter.js'

// Loaded here and not imported above: a static import is read with the file that holds it, before
// the cache is on, and in the bundled build would be merged into this very file.
const { main } = await import('./bin-main.js')

// Preserve source loaders and alternate installations when the public command differs.
main(fileURLToPath(import.meta.url))
