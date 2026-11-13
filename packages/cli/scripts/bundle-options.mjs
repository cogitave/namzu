// Options of the bundle that a test also reads, so that the test and the build cannot disagree.

/**
 * `process.env.NODE_ENV` is fixed to "production" in the text of the bundle.
 *
 * The renderer's React takes its development build unless NODE_ENV says "production", and the
 * development build copies and compares every prop of every component it draws into a profiling
 * record that is never freed. A long reply is a prop that is the whole text, so memory and work
 * grew with the square of the reply and one of about 130 KB ended the process. The choice is made
 * here, in the bundle, and not by writing NODE_ENV into the process: that environment is what the
 * shell tool hands to every command the person's agent runs.
 */
export const productionDefine = { 'process.env.NODE_ENV': '"production"' }
