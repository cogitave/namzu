/**
 * The data epoch: which generation of on-disk formats this engine writes.
 *
 * One integer, told to a host's client in the answer to `initialize`
 * (`kernel.dataEpoch`). A program that keeps several engines side by side and
 * lets them share one person's conversations compares it: two engines with the
 * same epoch can read and write each other's files; two with different epochs
 * may not.
 *
 * Raise it when an older engine can no longer safely read or write what this
 * one writes: a stamped store moves to a version the older one refuses, a
 * format gains a field the older one would drop or misread, a file is renamed
 * or moved. Do not raise it for a change an older engine ignores or reads the
 * same way. The inventory of formats, and the test that makes a change to a
 * stamped version a decision, are in `docs/sdk/kernel-facts.md`.
 */
export const DATA_EPOCH = 1
