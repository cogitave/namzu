// Deliberately-violating fixture for the getRootLogger() ratchet
// (checkGetRootLoggerRatchet). The rule only counts inside
// packages/sdk/src/, and this file physically lives under
// scripts/__fixtures__/log-standard/ — so the test supplies this text under
// a fabricated `rel` of "packages/sdk/src/__test-fixture__.ts" to exercise
// the scope filter, then varies `getRootLoggerCount` around the one real
// call below to drive both directions of the ratchet (a site added without
// updating the JSON, and a site removed without updating it).
export function fallbackLogger() {
	return getRootLogger()
}
