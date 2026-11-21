import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { connect, createServer } from "node:tls";
import { describe, expect, it } from "vitest";
import {
	exportMachineKeyPem,
	generateMachineKey,
	importMachineKeyPem,
	machineIdOf,
	netIdOf,
	shortMachineId,
	signBytes,
	verifyBytes,
} from "./identity.js";
import { buildMachineCertificate, certificatePublicKeyDer } from "./x509.js";

describe("machine identity", () => {
	it("names a machine by the digest of its public key and a network by its founder", () => {
		const key = generateMachineKey();
		expect(key.machineId).toMatch(/^[0-9a-f]{64}$/);
		expect(key.machineId).toBe(machineIdOf(key.publicKeyDer));
		expect(netIdOf(key.publicKeyDer)).toBe(key.machineId.slice(0, 16));
		expect(shortMachineId(key.machineId)).toHaveLength(12);
	});

	it("round-trips a key through PEM and refuses a key of another type", () => {
		const key = generateMachineKey();
		expect(importMachineKeyPem(exportMachineKeyPem(key)).machineId).toBe(
			key.machineId,
		);
		expect(() => importMachineKeyPem("not a key")).toThrow();
	});

	it("verifies its own signatures and nothing else", () => {
		const a = generateMachineKey();
		const b = generateMachineKey();
		const data = Buffer.from("hello");
		const sig = signBytes(a, data);
		expect(verifyBytes(a.publicKeyDer, data, sig)).toBe(true);
		expect(verifyBytes(b.publicKeyDer, data, sig)).toBe(false);
		expect(verifyBytes(a.publicKeyDer, Buffer.from("hellp"), sig)).toBe(false);
		expect(verifyBytes(Buffer.from("garbage"), data, sig)).toBe(false);
	});
});

describe("machine certificate", () => {
	it("parses with the platform parser, verifies, and carries the machine key", () => {
		const key = generateMachineKey();
		const cert = buildMachineCertificate(key, { now: Date.UTC(2026, 10, 21) });
		const parsed = new X509Certificate(cert.pem);
		expect(parsed.verify(key.publicKey)).toBe(true);
		expect(parsed.subject).toBe(`CN=namzu-${key.machineId.slice(0, 16)}`);
		expect(certificatePublicKeyDer(cert.der).equals(key.publicKeyDer)).toBe(
			true,
		);
		expect(parsed.ca).toBe(false);
	});

	it("gives two certificates for one key different serial numbers", () => {
		const key = generateMachineKey();
		expect(
			new X509Certificate(buildMachineCertificate(key).pem).serialNumber,
		).not.toBe(
			new X509Certificate(buildMachineCertificate(key).pem).serialNumber,
		);
	});

	it("completes a mutual TLS 1.3 handshake on loopback and shows each side the other key", async () => {
		const serverKey = generateMachineKey();
		const clientKey = generateMachineKey();
		const serverCert = buildMachineCertificate(serverKey);
		const clientCert = buildMachineCertificate(clientKey);
		let seenByServer: string | undefined;
		const server = createServer(
			{
				key: serverKey.privateKey.export({ type: "pkcs8", format: "pem" }),
				cert: serverCert.pem,
				requestCert: true,
				rejectUnauthorized: false,
				minVersion: "TLSv1.3",
			},
			(socket) => {
				seenByServer = machineIdOf(
					certificatePublicKeyDer(socket.getPeerCertificate(true).raw),
				);
				socket.end("ok");
			},
		);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const port = (server.address() as { port: number }).port;
		const socket = connect({
			host: "127.0.0.1",
			port,
			key: clientKey.privateKey.export({ type: "pkcs8", format: "pem" }),
			cert: clientCert.pem,
			rejectUnauthorized: false,
			minVersion: "TLSv1.3",
		});
		await once(socket, "secureConnect");
		socket.resume();
		const peer = machineIdOf(
			certificatePublicKeyDer(socket.getPeerCertificate(true).raw),
		);
		expect(peer).toBe(serverKey.machineId);
		await once(socket, "close");
		expect(seenByServer).toBe(clientKey.machineId);
		await new Promise<void>((r) => server.close(() => r()));
	});
});
