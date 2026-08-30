#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_ROOT_PREFIX = "namzu-sdk-tests-";
const TEST_ROOT_ENV = "NAMZU_SDK_TEST_ROOT";
const WORKER_VERIFIED_ENV = "NAMZU_SDK_TEST_WORKER_VERIFIED";
const DEBUG_ROOT_ENV = "NAMZU_SDK_TEST_DEBUG_ROOT";
const SIGNAL_GRACE_MS = 5_000;

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "..");
const sdkRoot = join(repositoryRoot, "packages", "sdk");
const requireFromSdk = createRequire(join(sdkRoot, "package.json"));
const vitestEntry = requireFromSdk.resolve("vitest/vitest.mjs");

const suites = new Map([
	["unit", "vitest.config.ts"],
	["proc", "vitest.proc.config.ts"],
]);

// These options can replace the root, config or process model that carries the
// isolation invariant. Supporting them would make `pnpm test -- <args>` look
// isolated while silently bypassing its owner.
const forbiddenOverrides = new Set([
	"-c",
	"-r",
	"--browser",
	"--browser.enabled",
	"--config",
	"--configLoader",
	"--dir",
	"--pool",
	"--root",
	"--setupFiles",
	"--workspace",
]);

function usage(message) {
	const error = new Error(
		`${message}\nUsage: node scripts/run-sdk-tests.mjs <unit|proc> [vitest arguments]`,
	);
	error.exitCode = 2;
	return error;
}

function validateArguments(args) {
	for (const argument of args) {
		const option = argument.split("=", 1)[0];
		if (option && forbiddenOverrides.has(option)) {
			throw usage(
				`${option} is owned by the SDK test runner and cannot be overridden.`,
			);
		}
	}
}

function validateOwnedRoot(path, temporaryRoot) {
	const name = basename(path);
	const suffix = name.slice(TEST_ROOT_PREFIX.length);
	if (
		dirname(path) !== temporaryRoot ||
		!name.startsWith(TEST_ROOT_PREFIX) ||
		suffix.length < 6 ||
		suffix.includes("/") ||
		suffix.includes("\\")
	) {
		throw new Error(
			`Refusing an SDK test root outside the owned temporary boundary: ${path}`,
		);
	}
}

async function removeOwnedRoot(path, temporaryRoot, identity) {
	let entry;
	try {
		entry = await lstat(path);
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ENOENT") {
			throw new Error(
				`SDK test root disappeared before its owner could clean it: ${path}`,
			);
		}
		throw error;
	}

	if (
		!entry.isDirectory() ||
		entry.isSymbolicLink() ||
		entry.dev !== identity.dev ||
		entry.ino !== identity.ino
	) {
		throw new Error(
			`Refusing to remove an SDK test root whose identity changed: ${path}`,
		);
	}

	const canonical = await realpath(path);
	validateOwnedRoot(canonical, temporaryRoot);
	if (canonical !== path) {
		throw new Error(
			`Refusing to remove an SDK test root whose canonical path changed: ${path}`,
		);
	}

	// Tests are trusted code and can still race this final removal. The identity
	// check prevents accidental path reuse; it is not a hostile-code boundary.
	await rm(path, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 50,
	});

	try {
		await lstat(path);
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ENOENT") return;
		throw error;
	}
	throw new Error(`SDK test root still exists after cleanup: ${path}`);
}

function waitForChild(child) {
	return new Promise((resolveChild, rejectChild) => {
		let settled = false;
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			rejectChild(error);
		});
		child.once("exit", (code, signal) => {
			if (settled) return;
			settled = true;
			resolveChild({ code, signal });
		});
	});
}

async function main() {
	const [suiteName, ...forwarded] = process.argv.slice(2);
	const configName = suites.get(suiteName);
	if (!configName)
		throw usage(`Unknown SDK test suite: ${suiteName ?? "(missing)"}.`);
	// pnpm keeps the conventional `--` script separator in the child argv, after
	// any arguments already written in package.json. It is not a Vitest filter
	// boundary here: forwarding it made a focused package command discover the
	// entire suite. Remove that one separator and preserve every caller value.
	const separator = forwarded.indexOf("--");
	const vitestArguments =
		separator === -1
			? forwarded
			: [...forwarded.slice(0, separator), ...forwarded.slice(separator + 1)];
	validateArguments(vitestArguments);

	let requestedSignal;
	let child;
	let signalEscalation;
	const signalChild = (signal) => {
		if (!child?.pid) return;
		try {
			if (process.platform === "win32") child.kill(signal);
			else process.kill(-child.pid, signal);
		} catch (error) {
			if (!error || typeof error !== "object" || error.code !== "ESRCH")
				throw error;
		}
	};
	const forwardSignal = (signal) => {
		if (requestedSignal) {
			signalChild("SIGKILL");
			return;
		}
		requestedSignal = signal;
		signalChild(signal);
		signalEscalation = setTimeout(
			() => signalChild("SIGKILL"),
			SIGNAL_GRACE_MS,
		);
	};
	const onInterrupt = () => forwardSignal("SIGINT");
	const onTerminate = () => forwardSignal("SIGTERM");
	process.on("SIGINT", onInterrupt);
	process.on("SIGTERM", onTerminate);

	let temporaryRoot;
	let ownedRoot;
	let ownedRootIdentity;
	let outcome;
	let childFailure;
	try {
		temporaryRoot = await realpath(tmpdir());
		const created = await mkdtemp(join(temporaryRoot, TEST_ROOT_PREFIX));
		ownedRoot = created;
		const identity = await lstat(created);
		ownedRootIdentity = { dev: identity.dev, ino: identity.ino };
		ownedRoot = await realpath(created);
		validateOwnedRoot(ownedRoot, temporaryRoot);

		if (!requestedSignal) {
			const childEnvironment = { ...process.env, [TEST_ROOT_ENV]: ownedRoot };
			delete childEnvironment[WORKER_VERIFIED_ENV];
			delete childEnvironment[DEBUG_ROOT_ENV];

			child = spawn(
				process.execPath,
				[
					vitestEntry,
					"run",
					"--root",
					sdkRoot,
					"--config",
					join(sdkRoot, configName),
					...vitestArguments,
				],
				{
					cwd: ownedRoot,
					detached: process.platform !== "win32",
					env: childEnvironment,
					stdio: "inherit",
				},
			);

			if (process.env[DEBUG_ROOT_ENV] === "1") {
				process.stderr.write(`[namzu:sdk-test-root] ${ownedRoot}\n`);
			}
			outcome = await waitForChild(child);
		}
	} catch (error) {
		childFailure = error;
	}

	let cleanupFailure;
	try {
		if (ownedRoot && temporaryRoot && ownedRootIdentity) {
			await removeOwnedRoot(ownedRoot, temporaryRoot, ownedRootIdentity);
		} else if (ownedRoot) {
			throw new Error(
				`SDK test root identity could not be established: ${ownedRoot}`,
			);
		}
	} catch (error) {
		cleanupFailure = error;
	} finally {
		if (signalEscalation) clearTimeout(signalEscalation);
		process.off("SIGINT", onInterrupt);
		process.off("SIGTERM", onTerminate);
	}

	if (cleanupFailure) {
		const reason =
			cleanupFailure instanceof Error
				? cleanupFailure.message
				: String(cleanupFailure);
		process.stderr.write(`[namzu:sdk-test-root] cleanup failed: ${reason}\n`);
	}

	const terminalSignal = outcome?.signal ?? requestedSignal;
	if (terminalSignal) {
		process.kill(process.pid, terminalSignal);
		return;
	}
	if (childFailure) throw childFailure;
	if (!outcome)
		throw new Error("SDK test process ended without an exit outcome.");

	process.exitCode = cleanupFailure ? 1 : (outcome.code ?? 1);
}

main().catch((error) => {
	const reason = error instanceof Error ? error.message : String(error);
	process.stderr.write(`[namzu:sdk-test-runner] ${reason}\n`);
	process.exitCode =
		error && typeof error === "object" && Number.isInteger(error.exitCode)
			? error.exitCode
			: 1;
});
