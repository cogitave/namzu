import { describe, expect, it } from "vitest";
import { type MachineKey, generateMachineKey } from "./identity.js";
import {
	type Admission,
	type MembershipState,
	admittedBy,
	createFounding,
	evaluateMembership,
	mergeMembership,
	signAdmission,
	signRevocation,
} from "./membership.js";

const T = 1_000_000;
function admit(
	signer: MachineKey,
	netId: string,
	joiner: MachineKey,
	at: number,
): Admission {
	return signAdmission(
		signer,
		netId,
		{
			machineId: joiner.machineId,
			publicKey: joiner.publicKeyDer.toString("base64"),
		},
		at,
	);
}

function setup() {
	const a = generateMachineKey();
	const b = generateMachineKey();
	const c = generateMachineKey();
	const d = generateMachineKey();
	const founding = createFounding(a, T);
	return { a, b, c, d, founding, netId: founding.netId };
}

describe("membership", () => {
	it("accepts a founding statement as the root of a network", () => {
		const { a, founding } = setup();
		const view = evaluateMembership({
			admissions: [founding],
			revocations: [],
		});
		expect([...view.members.keys()]).toEqual([a.machineId]);
		expect(view.netId).toBe(founding.netId);
	});

	it("rejects a founding statement whose network id is not the digest of its key", () => {
		const { founding } = setup();
		const forged = { ...founding, netId: "0".repeat(16) };
		expect(
			evaluateMembership({ admissions: [forged], revocations: [] }).members
				.size,
		).toBe(0);
	});

	it("admits by a member and by a member of a chain of three", () => {
		const { a, b, c, d, founding, netId } = setup();
		const view = evaluateMembership({
			admissions: [
				founding,
				admit(a, netId, b, T + 1),
				admit(b, netId, c, T + 2),
				admit(c, netId, d, T + 3),
			],
			revocations: [],
		});
		expect(view.members.size).toBe(4);
	});

	it("rejects an admission signed by a non-member", () => {
		const { b, c, founding, netId } = setup();
		const view = evaluateMembership({
			admissions: [founding, admit(b, netId, c, T + 1)],
			revocations: [],
		});
		expect(view.members.size).toBe(1);
		expect(view.admissions).toHaveLength(1);
	});

	it("rejects a tampered field and a key that does not match the machine id", () => {
		const { a, b, c, founding, netId } = setup();
		const good = admit(a, netId, b, T + 1);
		const tampered = { ...good, admittedAt: good.admittedAt + 1 };
		const swapped = { ...good, publicKey: c.publicKeyDer.toString("base64") };
		expect(
			evaluateMembership({ admissions: [founding, tampered], revocations: [] })
				.members.size,
		).toBe(1);
		expect(
			evaluateMembership({ admissions: [founding, swapped], revocations: [] })
				.members.size,
		).toBe(1);
	});

	it("rejects an admission from another network", () => {
		const { b, founding } = setup();
		const other = generateMachineKey();
		const otherFounding = createFounding(other, T);
		const x = admit(other, otherFounding.netId, b, T + 1);
		const view = evaluateMembership({
			admissions: [founding, x],
			revocations: [],
		});
		expect(view.members.has(b.machineId)).toBe(false);
	});

	it("removes a revoked machine for good and refuses to admit it again", () => {
		const { a, b, founding, netId } = setup();
		const rev = signRevocation(a, netId, b.machineId, false, T + 5);
		const again = admit(a, netId, b, T + 9);
		const view = evaluateMembership({
			admissions: [founding, admit(a, netId, b, T + 1), again],
			revocations: [rev],
		});
		expect(view.members.has(b.machineId)).toBe(false);
		expect(view.removed.has(b.machineId)).toBe(true);
	});

	it("drops an admission made after its signer was revoked, keeps one made before", () => {
		const { a, b, c, d, founding, netId } = setup();
		const rev = signRevocation(a, netId, b.machineId, false, T + 10);
		const before = admit(b, netId, c, T + 5);
		const after = admit(b, netId, d, T + 11);
		const view = evaluateMembership({
			admissions: [founding, admit(a, netId, b, T + 1), before, after],
			revocations: [rev],
		});
		expect(view.members.has(c.machineId)).toBe(true);
		expect(view.members.has(d.machineId)).toBe(false);
	});

	it("cascades over what the revoked machine admitted and nothing above it", () => {
		const { a, b, c, d, founding, netId } = setup();
		const state: MembershipState = {
			admissions: [
				founding,
				admit(a, netId, b, T + 1),
				admit(b, netId, c, T + 2),
				admit(a, netId, d, T + 3),
			],
			revocations: [signRevocation(a, netId, b.machineId, true, T + 9)],
		};
		const view = evaluateMembership(state);
		expect([...view.members.keys()].sort()).toEqual(
			[a.machineId, d.machineId].sort(),
		);
		expect(view.removed.has(c.machineId)).toBe(true);
		const plain = evaluateMembership({
			...state,
			revocations: [signRevocation(a, netId, b.machineId, false, T + 9)],
		});
		expect(plain.members.has(c.machineId)).toBe(true);
		expect(admittedBy(plain, b.machineId)).toEqual([c.machineId]);
	});

	it("ignores a revocation signed by a non-member", () => {
		const { a, b, c, founding, netId } = setup();
		const view = evaluateMembership({
			admissions: [founding, admit(a, netId, b, T + 1)],
			revocations: [signRevocation(c, netId, b.machineId, false, T + 2)],
		});
		expect(view.members.has(b.machineId)).toBe(true);
	});

	it("merges by union in any order and drops orphans", () => {
		const { a, b, c, d, founding, netId } = setup();
		const stmts: Admission[] = [
			admit(a, netId, b, T + 1),
			admit(b, netId, c, T + 2),
			admit(c, netId, d, T + 3),
		];
		const orphan = admit(
			generateMachineKey(),
			netId,
			generateMachineKey(),
			T + 4,
		);
		const expected = [a, b, c, d].map((k) => k.machineId).sort();
		const permutations = [
			[0, 1, 2],
			[2, 1, 0],
			[1, 2, 0],
			[2, 0, 1],
		];
		for (const order of permutations) {
			const left: MembershipState = {
				admissions: [
					founding,
					...order.slice(0, 1).map((i) => stmts[i] as Admission),
				],
				revocations: [],
			};
			const right: MembershipState = {
				admissions: [
					...order.slice(1).map((i) => stmts[i] as Admission),
					orphan,
				],
				revocations: [],
			};
			const view = mergeMembership(left, right);
			expect([...view.members.keys()].sort()).toEqual(expected);
			expect(view.admissions).not.toContain(orphan);
			expect([...mergeMembership(right, left).members.keys()].sort()).toEqual(
				expected,
			);
		}
	});

	it("settles when two revocations of one machine disagree on cascade", () => {
		const { a, b, c, founding, netId } = setup();
		const view = evaluateMembership({
			admissions: [
				founding,
				admit(a, netId, b, T + 1),
				admit(b, netId, c, T + 2),
			],
			revocations: [
				signRevocation(a, netId, b.machineId, true, T + 6),
				signRevocation(a, netId, b.machineId, false, T + 5),
			],
		});
		expect(view.members.has(c.machineId)).toBe(false);
	});
});
