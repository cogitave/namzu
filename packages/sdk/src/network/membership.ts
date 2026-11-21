/**
 * Membership of a Namzu network as signed statements, not a shared secret.
 *
 * The founder signs a statement admitting itself; every other machine is in
 * because an existing member signed an admission for it. A revocation is a
 * statement signed by a member. There is no network-wide key, so a stolen
 * machine can only vouch for machines until it is removed.
 *
 * This module is pure: no I/O, no clock. Every function takes the statements
 * and returns a verdict. Merging two sets of statements is a union followed by
 * re-validation, which is independent of the order the statements arrive in.
 *
 * Canonical bytes are the UTF-8 of a JSON array with a fixed field order,
 * prefixed by a domain string, so a signature for one kind of statement cannot
 * be replayed as another.
 *
 * @experimental
 */

import { z } from "zod";
import {
	type MachineKey,
	machineIdOf,
	netIdOf,
	signBytes,
	verifyBytes,
} from "./identity.js";

const HEX = /^[0-9a-f]+$/;

const MachineIdSchema = z.string().length(64).regex(HEX);

export const AdmissionSchema = z
	.object({
		netId: z.string().length(16).regex(HEX),
		machineId: MachineIdSchema,
		/** SPKI DER, base64. */
		publicKey: z.string().min(1).max(256),
		admittedBy: MachineIdSchema,
		admittedAt: z.number().int().nonnegative(),
		signature: z.string().min(1).max(256),
	})
	.strict();
export type Admission = z.infer<typeof AdmissionSchema>;

export const RevocationSchema = z
	.object({
		netId: z.string().length(16).regex(HEX),
		machineId: MachineIdSchema,
		revokedBy: MachineIdSchema,
		revokedAt: z.number().int().nonnegative(),
		cascade: z.boolean(),
		signature: z.string().min(1).max(256),
	})
	.strict();
export type Revocation = z.infer<typeof RevocationSchema>;

export const ADMIT_DOMAIN = "namzu-net/admit/1";
export const REVOKE_DOMAIN = "namzu-net/revoke/1";

export function canonicalAdmission(a: Omit<Admission, "signature">): Buffer {
	return Buffer.from(
		`${ADMIT_DOMAIN}\n${JSON.stringify([a.netId, a.machineId, a.publicKey, a.admittedBy, a.admittedAt])}`,
		"utf8",
	);
}

export function canonicalRevocation(r: Omit<Revocation, "signature">): Buffer {
	return Buffer.from(
		`${REVOKE_DOMAIN}\n${JSON.stringify([r.netId, r.machineId, r.revokedBy, r.revokedAt, r.cascade])}`,
		"utf8",
	);
}

/** The founding statement: self-signed, and the root every chain must reach. */
export function createFounding(key: MachineKey, now: number): Admission {
	const body = {
		netId: netIdOf(key.publicKeyDer),
		machineId: key.machineId,
		publicKey: key.publicKeyDer.toString("base64"),
		admittedBy: key.machineId,
		admittedAt: now,
	};
	return {
		...body,
		signature: signBytes(key, canonicalAdmission(body)).toString("base64"),
	};
}

export function signAdmission(
	signer: MachineKey,
	netId: string,
	joiner: { readonly machineId: string; readonly publicKey: string },
	now: number,
): Admission {
	const body = {
		netId,
		machineId: joiner.machineId,
		publicKey: joiner.publicKey,
		admittedBy: signer.machineId,
		admittedAt: now,
	};
	return {
		...body,
		signature: signBytes(signer, canonicalAdmission(body)).toString("base64"),
	};
}

export function signRevocation(
	signer: MachineKey,
	netId: string,
	machineId: string,
	cascade: boolean,
	now: number,
): Revocation {
	const body = {
		netId,
		machineId,
		revokedBy: signer.machineId,
		revokedAt: now,
		cascade,
	};
	return {
		...body,
		signature: signBytes(signer, canonicalRevocation(body)).toString("base64"),
	};
}

function admissionIntact(a: Admission, signerKeyB64: string): boolean {
	const publicKey = Buffer.from(a.publicKey, "base64");
	if (machineIdOf(publicKey) !== a.machineId) return false;
	return verifyBytes(
		Buffer.from(signerKeyB64, "base64"),
		canonicalAdmission(a),
		Buffer.from(a.signature, "base64"),
	);
}

function isFounding(a: Admission): boolean {
	if (a.admittedBy !== a.machineId) return false;
	return netIdOf(Buffer.from(a.publicKey, "base64")) === a.netId;
}

export interface MembershipState {
	readonly admissions: readonly Admission[];
	readonly revocations: readonly Revocation[];
}

export interface MembershipView {
	readonly netId: string | undefined;
	/** Current members: valid admission, not revoked. */
	readonly members: ReadonlyMap<string, Admission>;
	/** Every machine with a valid revocation or removed by a cascade; never to be re-admitted. */
	readonly removed: ReadonlySet<string>;
	/** The statements that survived validation, ready to store or send. */
	readonly admissions: readonly Admission[];
	readonly revocations: readonly Revocation[];
}

/**
 * Validate a set of statements for one network (the one whose founding
 * statement is in the set). Invalid and orphan statements are dropped.
 */
export function evaluateMembership(
	state: MembershipState,
	expectedNetId?: string,
): MembershipView {
	const founding = [...state.admissions]
		.filter(
			(a) =>
				isFounding(a) &&
				(expectedNetId === undefined || a.netId === expectedNetId),
		)
		.filter((a) => admissionIntact(a, a.publicKey))
		.sort((a, b) => a.machineId.localeCompare(b.machineId))[0];
	if (!founding) {
		return {
			netId: undefined,
			members: new Map(),
			removed: new Set(),
			admissions: [],
			revocations: [],
		};
	}
	const netId = founding.netId;
	const sameNet = state.admissions.filter(
		(a) => a.netId === netId && a !== founding,
	);
	const revs = state.revocations.filter((r) => r.netId === netId);

	const solve = (excluded: ReadonlySet<string>) => {
		const valid = new Map<string, Admission>([[founding.machineId, founding]]);
		const validRevs = new Map<string, Revocation>();
		const revokedAtBy = (id: string) => validRevs.get(id)?.revokedAt;
		// Fixpoint: statements become valid once their signer is. Monotone, so order independent.
		for (let changed = true; changed; ) {
			changed = false;
			const ordered = [...sameNet].sort(
				(a, b) =>
					a.admittedAt - b.admittedAt ||
					a.admittedBy.localeCompare(b.admittedBy),
			);
			for (const a of ordered) {
				if (excluded.has(a.signature) || valid.has(a.machineId)) continue;
				const signer = valid.get(a.admittedBy);
				if (!signer || !admissionIntact(a, signer.publicKey)) continue;
				const signerRevokedAt = revokedAtBy(a.admittedBy);
				if (signerRevokedAt !== undefined && a.admittedAt > signerRevokedAt)
					continue;
				valid.set(a.machineId, a);
				changed = true;
			}
			for (const r of revs) {
				if (excluded.has(r.signature)) continue;
				const signer = valid.get(r.revokedBy);
				if (!signer) continue;
				const signerRevokedAt = revokedAtBy(r.revokedBy);
				if (signerRevokedAt !== undefined && r.revokedAt > signerRevokedAt)
					continue;
				if (
					!verifyBytes(
						Buffer.from(signer.publicKey, "base64"),
						canonicalRevocation(r),
						Buffer.from(r.signature, "base64"),
					)
				) {
					continue;
				}
				const existing = validRevs.get(r.machineId);
				if (existing && existing.signature === r.signature) continue;
				// Keep the earliest valid revocation; a cascade is kept if any valid revocation of the machine carries it.
				const earliest =
					!existing || r.revokedAt < existing.revokedAt ? r : existing;
				const cascade = r.cascade || existing?.cascade === true;
				const chosen =
					earliest.cascade === cascade
						? earliest
						: r.cascade
							? r
							: (existing as Revocation);
				if (chosen !== existing) {
					validRevs.set(r.machineId, chosen);
					changed = true;
				}
			}
		}
		return { valid, validRevs };
	};
	// A statement that became valid before its signer's revocation was known may turn out to
	// post-date it; exclude and solve again until nothing violates.
	const excluded = new Set<string>();
	let solved = solve(excluded);
	for (let again = true; again; ) {
		again = false;
		for (const a of solved.valid.values()) {
			const at = solved.validRevs.get(a.admittedBy)?.revokedAt;
			if (a !== founding && at !== undefined && a.admittedAt > at) {
				excluded.add(a.signature);
				again = true;
			}
		}
		for (const r of solved.validRevs.values()) {
			const at = solved.validRevs.get(r.revokedBy)?.revokedAt;
			if (at !== undefined && r.revokedAt > at) {
				excluded.add(r.signature);
				again = true;
			}
		}
		if (again) solved = solve(excluded);
	}
	const { valid, validRevs } = solved;

	const removed = new Set<string>(validRevs.keys());
	// Cascade: everything a cascade-revoked machine admitted, recursively.
	const queue = [...validRevs.values()]
		.filter((r) => r.cascade)
		.map((r) => r.machineId);
	while (queue.length > 0) {
		const parent = queue.pop() as string;
		for (const [id, adm] of valid) {
			if (adm.admittedBy === parent && id !== parent && !removed.has(id)) {
				removed.add(id);
				queue.push(id);
			}
		}
	}
	const members = new Map([...valid].filter(([id]) => !removed.has(id)));
	return {
		netId,
		members,
		removed,
		admissions: [...valid.values()],
		revocations: [...validRevs.values()],
	};
}

/** Union of two sets of statements, re-validated. Order of arguments does not matter. */
export function mergeMembership(
	a: MembershipState,
	b: MembershipState,
	expectedNetId?: string,
): MembershipView {
	const adm = new Map<string, Admission>();
	for (const x of [...a.admissions, ...b.admissions]) adm.set(x.signature, x);
	const rev = new Map<string, Revocation>();
	for (const x of [...a.revocations, ...b.revocations]) rev.set(x.signature, x);
	return evaluateMembership(
		{ admissions: [...adm.values()], revocations: [...rev.values()] },
		expectedNetId,
	);
}

/** The machines `machineId` admitted that are still members: what `remove` lists before a cascade. */
export function admittedBy(view: MembershipView, machineId: string): string[] {
	return [...view.members.values()]
		.filter((m) => m.admittedBy === machineId && m.machineId !== machineId)
		.map((m) => m.machineId);
}

/** Whether `candidate` is a statement that would be dropped; used to reject bad input at the wire. */
export function parseAdmission(value: unknown): Admission | undefined {
	const r = AdmissionSchema.safeParse(value);
	return r.success ? r.data : undefined;
}
export function parseRevocation(value: unknown): Revocation | undefined {
	const r = RevocationSchema.safeParse(value);
	return r.success ? r.data : undefined;
}
