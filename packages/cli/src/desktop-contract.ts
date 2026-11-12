/**
 * The desktop contract: which generation of this command line an installed Namzu
 * Desktop application can live with.
 *
 * One integer, told in the answer to `initialize` as `kernel.desktopContract` by a
 * host started for the desktop application (`namzu acp --desktop`). The application
 * is built with the range of numbers it accepts and uses a newer command line it
 * fetched on its own only when this number is inside that range.
 *
 * Raise it only for a change an already installed application cannot live with: a
 * method it requires or probes is removed or renamed, a notification it consumes is
 * renamed, a shape it validates strictly changes in a way its copy rejects, a flag it
 * passes is refused, the folder layout it reads versions from moves, or something it
 * hands to the command line (a resource folder, an environment variable) changes its
 * meaning. An addition an older application ignores only needs the new value recorded.
 * The inventory is `desktop-contract/inventory.json` in this package, the guard is
 * `src/desktop-contract.test.ts`, and the page that explains both is
 * `docs/sdk/kernel-facts.md`.
 */
export const DESKTOP_CONTRACT = 1
