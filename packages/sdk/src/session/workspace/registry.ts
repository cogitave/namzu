/**
 * WorkspaceBackendRegistry — deny-by-default driver lookup.
 *
 * Convention #9 (Registry + Manager + Store): this is the Registry for
 * {@link WorkspaceBackendDriver} implementations. Unknown kinds throw
 * — no silent fallback (Convention #5).
 */

import type { WorkspaceBackendDriver, WorkspaceBackendKind } from './driver.js'

export class WorkspaceBackendRegistry {
	private readonly drivers = new Map<WorkspaceBackendKind, WorkspaceBackendDriver>()

	/**
	 * Registers a driver. A second registration for the same kind replaces the
	 * previous entry (test ergonomics); production code should register each
	 * backend exactly once at boot.
	 */
	register(driver: WorkspaceBackendDriver): void {
		this.drivers.set(driver.kind, driver)
	}

	/**
	 * Returns the driver for `kind`. Throws when no driver is registered —
	 * deny-by-default per Convention #5; the caller must register every
	 * backend their workload can reach before invoking this.
	 */
	get(kind: WorkspaceBackendKind): WorkspaceBackendDriver {
		const driver = this.drivers.get(kind)
		if (!driver) {
			throw new Error(
				`No WorkspaceBackendDriver registered for kind "${kind}". Register one before use.`,
			)
		}
		return driver
	}

	/** True iff a driver for `kind` has been registered. */
	has(kind: WorkspaceBackendKind): boolean {
		return this.drivers.has(kind)
	}
}
