#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs";
import * as dotenv from "dotenv";
dotenv.config();

const optimistUsageLength = 98;
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { PeerServer } from "../src/index.ts";
import type { AddressInfo } from "node:net";
import type { CorsOptions } from "cors";

const y = yargs(hideBin(process.argv));

const portEnvIsSet = !!process.env["PORT"];

const opts = y
	.usage("Usage: $0")
	.wrap(Math.min(optimistUsageLength, y.terminalWidth()))
	.options({
		expire_timeout: {
			demandOption: false,
			alias: "t",
			describe: "timeout (milliseconds)",
			default: process.env["EXPIRE_TIMEOUT"]
				? parseInt(process.env["EXPIRE_TIMEOUT"])
				: 5000,
		},
		concurrent_limit: {
			demandOption: false,
			alias: "c",
			describe: "concurrent limit",
			default: process.env["CONCURRENT_LIMIT"]
				? parseInt(process.env["CONCURRENT_LIMIT"])
				: 5000,
		},
		alive_timeout: {
			demandOption: false,
			describe: "broken connection check timeout (milliseconds)",
			default: process.env["ALIVE_TIMEOUT"]
				? parseInt(process.env["ALIVE_TIMEOUT"])
				: 60000,
		},
		key: {
			demandOption: false,
			alias: "k",
			describe: "connection key",
			default: process.env["KEY"] ?? "peerjs",
		},
		sslkey: {
			type: "string",
			demandOption: false,
			describe: "path to SSL key",
			default: process.env["SSL_KEY"],
		},
		sslcert: {
			type: "string",
			demandOption: false,
			describe: "path to SSL certificate",
			default: process.env["SSL_CERT"],
		},
		host: {
			type: "string",
			demandOption: false,
			alias: "H",
			describe: "host",
			default: process.env["HOST"] ?? "::",
		},
		port: {
			type: "number",
			demandOption: !portEnvIsSet,
			alias: "p",
			describe: "port",
		},
		path: {
			type: "string",
			demandOption: false,
			describe: "custom path",
			default: process.env["PEERSERVER_PATH"] ?? "/",
		},
		allow_discovery: {
			type: "boolean",
			demandOption: false,
			describe: "allow discovery of peers",
			default: process.env["ALLOW_DISCOVERY"] === "true",
		},
		proxied: {
			type: "boolean",
			demandOption: false,
			describe: "Set true if PeerServer stays behind a reverse proxy",
			default: process.env["PROXIED"] === "true",
		},
		cors: {
			type: "string",
			array: true,
			describe: "Set the list of CORS origins",
			default: process.env["CORS_ORIGINS"]
				? process.env["CORS_ORIGINS"].split(",")
				: undefined,
		},
		"redis-host": {
			type: "string",
			demandOption: false,
			describe: "Redis host",
			default: process.env["REDIS_HOST"],
		},
		"redis-port": {
			type: "number",
			demandOption: false,
			describe: "Redis port",
			default: process.env["REDIS_PORT"]
				? parseInt(process.env["REDIS_PORT"])
				: undefined,
		},
		"redis-password": {
			type: "string",
			demandOption: false,
			describe: "Redis password",
			default: process.env["REDIS_PASSWORD"],
		},
		"message-queue-enabled": {
			type: "boolean",
			demandOption: false,
			describe: "Enable message queueing (persistence/offline support)",
			default: process.env["MESSAGE_QUEUE_ENABLED"] !== "false",
		},
		"redis-ttl": {
			type: "number",
			demandOption: false,
			describe: "Redis message queue TTL in seconds",
			default: process.env["REDIS_TTL"]
				? parseInt(process.env["REDIS_TTL"])
				: 24 * 60 * 60,
		},
	})
	.boolean("allow_discovery")
	.boolean("message-queue-enabled")
	.parseSync();

if (!opts.port) {
	// .port is only not set if the PORT env var is set
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	opts.port = parseInt(process.env["PORT"]!);
}
if (opts.cors) {
	opts["corsOptions"] = {
		origin: opts.cors,
	} satisfies CorsOptions;
}
// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
if (opts["redis-host"] || opts["redis-port"]) {
	opts["redisOptions"] = {
		host: opts["redis-host"],
		port: opts["redis-port"],
		password: opts["redis-password"],
	};
}
// Map CLI/ENV to library config names
opts["message_queue_enabled"] = opts["message-queue-enabled"];
opts["redis_ttl"] = opts["redis-ttl"];
process.on("uncaughtException", function (e) {
	console.error("Error: " + e.toString());
});

if (opts.sslkey ?? opts.sslcert) {
	if (opts.sslkey && opts.sslcert) {
		opts["ssl"] = {
			key: fs.readFileSync(path.resolve(opts.sslkey)),
			cert: fs.readFileSync(path.resolve(opts.sslcert)),
		};
	} else {
		console.error(
			"Warning: PeerServer will not run because either " +
				"the key or the certificate has not been provided.",
		);
		process.exit(1);
	}
}

const userPath = opts.path;
const server = PeerServer(opts, (server) => {
	const { address: host, port } = server.address() as AddressInfo;

	console.log(
		"Started PeerServer on %s, port: %s, path: %s",
		host,
		port,
		// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
		userPath || "/",
	);

	const shutdownApp = () => {
		server.close(() => {
			console.log("Http server closed.");

			process.exit(0);
		});
	};

	process.on("SIGINT", shutdownApp);
	process.on("SIGTERM", shutdownApp);
});

server.on("connection", (client) => {
	console.log(`Client connected: ${client.getId()}`);
});

server.on("disconnect", (client) => {
	console.log(`Client disconnected: ${client.getId()}`);
});
