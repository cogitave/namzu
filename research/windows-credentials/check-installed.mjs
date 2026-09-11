// Native Windows only:
// node check-installed.mjs <consumer-root-containing-node_modules>
// Exercises installed CLI files in fresh TEMP state. No models, installs or login.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const checks = {};
let stage = "native-runtime";
let fixture;
let result;

function check(name, operation) {
	stage = name;
	operation();
	checks[name] = true;
}

function fingerprint(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

try {
	assert.equal(process.platform, "win32");
	assert.equal(process.argv.length, 3);
	const consumer = resolve(process.argv[2]);
	const cli = join(consumer, "node_modules", "@namzu", "cli");
	const sdk = join(consumer, "node_modules", "@namzu", "sdk");
	stage = "installed-imports";
	const storePath = join(
		cli,
		"dist",
		"integrations",
		"providers",
		"credential-store.js",
	);
	const directoryPath = join(
		cli,
		"dist",
		"integrations",
		"state",
		"private-directory.js",
	);
	const bin = join(cli, "dist", "bin.js");
	const store = await import(pathToFileURL(storePath).href);
	const { ensurePrivateStateDirectory } = await import(
		pathToFileURL(directoryPath).href
	);
	const cliPackage = JSON.parse(
		readFileSync(join(cli, "package.json"), "utf8"),
	);
	const sdkPackage = JSON.parse(
		readFileSync(join(sdk, "package.json"), "utf8"),
	);
	checks.installedDistImports = true;
	stage = "private-temp-fixture";
	fixture = mkdtempSync(join(tmpdir(), "namzu-installed-acl-"));
	store.restrictToOwner(fixture);
	const sid = store.currentUserSid();
	assert.ok(sid);
	const icacls = join(
		process.env.SystemRoot ?? "C:\\Windows",
		"System32",
		"icacls.exe",
	);
	const acl = (path) => {
		const descriptor = store.readAclSddl(path);
		assert.ok(descriptor);
		return descriptor;
	};
	const allowEntries = (path) => {
		const dacl = acl(path).match(/D:([A-Z]*)(.*?)(?=[OGS]:|[\r\n]|$)/u);
		assert.ok(dacl);
		return [...dacl[2].matchAll(/\(([^)]*)\)/gu)]
			.map((match) => match[1].split(";"))
			.filter((entry) => entry[0] === "A");
	};
	const principal = (value) => (value === "SY" ? "S-1-5-18" : value);
	const assertOwnerAccess = (
		path,
		{ inherited = false, inheritable = false, system = false } = {},
	) => {
		const entries = allowEntries(path);
		assert.ok(entries.length > 0);
		const owner = entries.filter((entry) => principal(entry[5]) === sid);
		assert.ok(owner.some((entry) => entry[2] && !entry[1].includes("IO")));
		for (const entry of entries) {
			assert.ok(
				principal(entry[5]) === sid ||
					(system && principal(entry[5]) === "S-1-5-18"),
			);
		}
		if (inherited) assert.ok(owner.some((entry) => entry[1].includes("ID")));
		if (inheritable)
			assert.ok(
				owner.some(
					(entry) => entry[1].includes("OI") && entry[1].includes("CI"),
				),
			);
	};
	const setExplicit = (path, ...grants) =>
		execFileSync(
			icacls,
			[path, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, ...grants],
			{
				stdio: "ignore",
				timeout: 10_000,
				windowsHide: true,
			},
		);

	const projects = ensurePrivateStateDirectory(fixture, "projects");
	check("securedProjectsHasInheritableOwnerGrant", () => {
		store.assertSoleOwnerSddl(acl(projects), sid, "<fixture>/projects");
		assertOwnerAccess(projects, { inheritable: true });
	});
	const project = join(projects, "synthetic-project");
	mkdirSync(project);
	check("plainProjectInheritsOwnerWithoutForeignGrants", () =>
		assertOwnerAccess(project, { inherited: true, inheritable: true }),
	);
	const cliState = ensurePrivateStateDirectory(project, "cli");
	check("nestedCliPartitionIsPrivateAndInheritable", () => {
		store.assertSoleOwnerSddl(
			acl(cliState),
			sid,
			"<fixture>/projects/project/cli",
		);
		assertOwnerAccess(cliState, { inheritable: true });
	});
	const nested = join(cliState, "plain-descendant");
	mkdirSync(nested);
	const stateFile = join(nested, "state.json");
	writeFileSync(stateFile, '{"synthetic":true}\n');
	check("plainDescendantAndStateFileInheritOnlyOwner", () => {
		assertOwnerAccess(nested, { inherited: true, inheritable: true });
		assertOwnerAccess(stateFile, { inherited: true });
	});

	const legacy = join(fixture, "legacy");
	mkdirSync(legacy);
	setExplicit(legacy, "*S-1-5-32-544:(OI)(CI)F");
	check("explicitAdministratorsDirectoryInitiallyRefused", () => {
		assert.throws(
			() => store.assertSoleOwnerSddl(acl(legacy), sid, "<fixture>/legacy"),
			/account other than yours/u,
		);
	});
	const oldChild = join(legacy, "existing-descendant");
	mkdirSync(oldChild);
	setExplicit(oldChild, "*S-1-5-32-544:F");
	check("namedDirectoryAdministratorsGrantRepaired", () => {
		assert.equal(ensurePrivateStateDirectory(fixture, "legacy"), legacy);
		store.assertSoleOwnerSddl(acl(legacy), sid, "<fixture>/legacy");
		assertOwnerAccess(legacy, { inheritable: true });
	});
	check("parserStillRefusesAdministratorsIndependently", () => {
		assert.throws(
			() =>
				store.assertSoleOwnerSddl(
					`D:P(A;;FA;;;${sid})(A;;FA;;;BA)`,
					sid,
					"<synthetic>",
				),
			/account other than yours/u,
		);
	});
	check("repairDoesNotMigrateExistingExplicitDescendantGrants", () => {
		assert.ok(
			allowEntries(oldChild).some((entry) =>
				["BA", "S-1-5-32-544"].includes(entry[5]),
			),
		);
		assert.throws(
			() =>
				store.assertSoleOwnerSddl(acl(oldChild), sid, "<fixture>/legacy/child"),
			/account other than yours/u,
		);
	});

	const withSystem = join(fixture, "with-system");
	mkdirSync(withSystem);
	setExplicit(withSystem, "*S-1-5-18:F");
	check("ownerAndLocalSystemAccepted", () => {
		assert.equal(
			ensurePrivateStateDirectory(fixture, "with-system"),
			withSystem,
		);
		store.assertSoleOwnerSddl(acl(withSystem), sid, "<fixture>/with-system");
		assertOwnerAccess(withSystem, { inheritable: true, system: true });
		assert.ok(
			allowEntries(withSystem).some(
				(entry) => principal(entry[5]) === "S-1-5-18",
			),
		);
	});
	const foreign = join(fixture, "foreign");
	mkdirSync(foreign);
	setExplicit(foreign, "*S-1-1-0:F");
	check("everyoneGrantStillRefused", () => {
		assert.throws(
			() => ensurePrivateStateDirectory(fixture, "foreign"),
			/account other than yours/u,
		);
	});

	stage = "isolated-cli-environment";
	const syntheticProfile = join(fixture, "profile");
	const syntheticHome = join(fixture, "namzu-home");
	const work = join(fixture, "working-project");
	const localAppData = join(syntheticProfile, "AppData", "Local");
	const appData = join(syntheticProfile, "AppData", "Roaming");
	const xdgConfig = join(syntheticProfile, "xdg-config");
	const xdgData = join(syntheticProfile, "xdg-data");
	const xdgCache = join(syntheticProfile, "xdg-cache");
	for (const path of [
		syntheticHome,
		work,
		localAppData,
		appData,
		xdgConfig,
		xdgData,
		xdgCache,
	]) {
		mkdirSync(path, { recursive: true });
	}
	const env = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (
			[
				"PATH",
				"PATHEXT",
				"SYSTEMROOT",
				"WINDIR",
				"COMSPEC",
				"TEMP",
				"TMP",
			].includes(name.toUpperCase())
		) {
			env[name] = value;
		}
	}
	Object.assign(env, {
		NAMZU_HOME: syntheticHome,
		USERPROFILE: syntheticProfile,
		HOME: syntheticProfile,
		APPDATA: appData,
		LOCALAPPDATA: localAppData,
		XDG_CONFIG_HOME: xdgConfig,
		XDG_DATA_HOME: xdgData,
		XDG_CACHE_HOME: xdgCache,
		NO_COLOR: "1",
		CI: "1",
	});
	const invoke = (args) => {
		const child = spawnSync(process.execPath, [bin, ...args], {
			cwd: work,
			env,
			encoding: "utf8",
			timeout: 30_000,
			windowsHide: true,
		});
		assert.equal(child.error, undefined);
		assert.equal(child.status, 0);
		return child.stdout;
	};
	check("installedBinVersionRuns", () => {
		assert.ok(invoke(["--version"]).includes(cliPackage.version));
	});
	const objective =
		"Retain this synthetic offline objective. No model execution is authorized.";
	check("installedResidentAddRunsWithoutProvider", () => {
		invoke([
			"--format",
			"json",
			"resident",
			"add",
			"--cwd",
			work,
			"--trust",
			"--",
			objective,
		]);
	});
	let status;
	check("installedResidentStatusRetainsUnadmittedObjective", () => {
		status = JSON.parse(
			invoke(["--format", "json", "resident", "status", "--cwd", work]),
		);
		assert.equal(status.agenda.pursuits.length, 1);
		assert.equal(status.agenda.pursuits[0].state.objective, objective);
		assert.equal(status.agenda.pursuits[0].state.stepsAdmitted, 0);
		assert.equal(status.agenda.pursuits[0].state.phase, "waiting");
		assert.equal(status.agenda.pursuits[0].state.claimId, null);
		assert.equal(status.runner?.owner ?? null, null);
	});
	let generatedEntries = 0;
	check("installedCliGeneratedStateHasNoForeignAllowGrants", () => {
		const visit = (directory) => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				assertOwnerAccess(path, { system: true });
				generatedEntries++;
				if (entry.isDirectory()) visit(path);
			}
		};
		visit(syntheticHome);
		assert.ok(generatedEntries > 0);
	});
	result = {
		date: "2026-09-11",
		kind: "native-windows-installed-cli-privacy",
		platform: process.platform,
		node: process.version,
		installedVersions: { cli: cliPackage.version, sdk: sdkPackage.version },
		installedSha256: {
			credentialStore: fingerprint(storePath),
			privateDirectory: fingerprint(directoryPath),
			cliBin: fingerprint(bin),
		},
		checks,
		generatedEntriesChecked: generatedEntries,
		modelCalls: 0,
		installs: 0,
		loginAttempts: 0,
		commands: [
			"installed bin --version",
			"resident add --trust",
			"resident status",
		],
		boundary:
			"Actual installed CLI dist modules and bin executed by native Windows Node against fresh private TEMP fixtures. Child CLI environment uses isolated Namzu, profile and XDG directories; no credentials or live provider calls are involved.",
		limitations: [
			"Directory repair tightens the named directory; it does not migrate existing descendants with explicit Administrators grants.",
			"LocalSystem is allowed; Administrators remains refused by the descriptor parser and is removed only during named-directory repair.",
			"This check covers local installed CLI startup and resident state creation, not a full TUI or provider login/inference.",
		],
	};
} catch {
	result = {
		date: "2026-09-11",
		kind: "native-windows-installed-cli-privacy",
		platform: process.platform,
		node: process.version,
		checks,
		failedStage: stage,
		modelCalls: 0,
		installs: 0,
		loginAttempts: 0,
	};
	process.exitCode = 1;
} finally {
	try {
		if (fixture) rmSync(fixture, { recursive: true, force: true });
		checks.privateFixtureRemoved = true;
	} catch {
		checks.privateFixtureRemoved = false;
		process.exitCode = 1;
	}
}

result.passed = !result.failedStage && Object.values(checks).every(Boolean);
const output = fileURLToPath(
	new URL("./results/2026-09-11-installed.json", import.meta.url),
);
try {
	writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
} catch {
	process.stderr.write(
		"Could not write the sanitized installed-check result.\n",
	);
	process.exitCode = 1;
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
