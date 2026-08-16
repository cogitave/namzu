/**
 * Resolves a config field that is being renamed, while both names are live.
 *
 * A deprecation window means two spellings of one field accept values at the
 * same time, and the interesting case is not "which do we prefer" — it is
 * what to do when a caller sets BOTH to different things. Preferring one
 * silently would run with a value the caller also told us not to use, which
 * is the quiet degradation this repo's `refuse-do-not-degrade` rule exists
 * to prevent. There is no correct guess available: a caller who set both has
 * a genuine disagreement with themselves, and the only honest answer is to
 * say so and name both fields, so the message points at the two lines they
 * have to reconcile rather than at this helper.
 *
 * Identical values are not a disagreement — a host spreading one object into
 * both spellings during its own migration is stating one thing twice. That
 * passes.
 */
export function pickRenamed<T>(
	oldName: string,
	oldValue: T | undefined,
	newName: string,
	newValue: T | undefined,
): T | undefined {
	if (oldValue !== undefined && newValue !== undefined && oldValue !== newValue) {
		throw new Error(
			`Both \`${oldName}\` and \`${newName}\` were set to different values. \`${oldName}\` is the deprecated spelling of \`${newName}\`; pass one. Neither was used, because choosing between them would mean running with a value you also asked not to use.`,
		)
	}
	// The order here carries no information, and that is worth saying so
	// nobody "corrects" it later: by this line the both-set case has already
	// been fully decided above — either it threw, or the two are identical
	// and either branch returns the same object. Written new-first only
	// because it reads as the direction of travel.
	return newValue ?? oldValue
}
