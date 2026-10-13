import { enableStartupCompileCache } from './compile-cache.js'

// Imported first by `bin.ts`, for its effect: the cache covers the modules
// loaded after this one, so it has to run before the command shell is read.
enableStartupCompileCache()
