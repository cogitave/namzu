import assert from "node:assert/strict";
import { test } from "node:test";

import { analyse } from "../../.github/scripts/check-test-coverage-union.mjs";

const PACKAGES = ["@namzu/a", "@namzu/sdk", "@namzu/cli"];

const workflow = ({
	recursive = "pnpm -r --no-sort --filter '!@namzu/sdk' --filter '!@namzu/cli' test",
	sdk = "      - run: pnpm --filter @namzu/sdk test:coverage",
	shards = "[1, 2, 3]",
	cliCommand = "pnpm --filter @namzu/cli test --shard=${{ matrix.shard }}/3",
} = {}) => `name: CI
jobs:
  check:
    steps:
      - name: Test
        run: ${recursive}
  sdk:
    steps:
${sdk}
  cli:
    strategy:
      matrix:
        node-version: [22, 24]
        shard: ${shards}
    steps:
      - name: Test
        run: ${cliCommand}
`;

test("a complete schedule has no problems", () => {
	assert.deepEqual(analyse(workflow(), PACKAGES).problems, []);
});

test("a package filtered out of the recursive run and run nowhere is reported", () => {
	const { problems } = analyse(
		workflow({ sdk: "      - run: echo nothing" }),
		PACKAGES,
	);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /@namzu\/sdk .*no job/);
});

test("a shard list shorter than the shard count is reported", () => {
	const { problems } = analyse(workflow({ shards: "[1, 2]" }), PACKAGES);
	assert.ok(
		problems.some((p) => /3 shards but its `shard:` list is \[1, 2\]/.test(p)),
	);
	assert.ok(problems.some((p) => /@namzu\/cli .*no job/.test(p)));
});

test("a shard option it cannot read covers nothing", () => {
	const { problems } = analyse(
		workflow({ cliCommand: "pnpm --filter @namzu/cli test --shard 1/3" }),
		PACKAGES,
	);
	assert.ok(problems.some((p) => /cannot read/.test(p)));
	assert.ok(problems.some((p) => /@namzu\/cli .*no job/.test(p)));
});

test("a missing recursive run is reported", () => {
	const { problems } = analyse(
		workflow({ recursive: "echo skipped" }),
		PACKAGES,
	);
	assert.ok(problems.some((p) => /no job runs `pnpm -r/.test(p)));
});

test("a positive filter on the recursive run is reported", () => {
	const { problems } = analyse(
		workflow({ recursive: "pnpm -r --filter @namzu/a test" }),
		PACKAGES,
	);
	assert.ok(problems.some((p) => /positive --filter/.test(p)));
});

test("excluding a package that has no test script is reported", () => {
	const { problems } = analyse(
		workflow({ recursive: "pnpm -r --filter '!@namzu/ghost' test" }),
		PACKAGES,
	);
	assert.ok(problems.some((p) => /@namzu\/ghost/.test(p)));
});
