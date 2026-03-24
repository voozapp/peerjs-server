import type express from "express";
import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import path from "node:path";
import type { IRealm } from "./models/realm.ts";
import { Realm } from "./models/realm.ts";
import { CheckBrokenConnections } from "./services/checkBrokenConnections/index.ts";
import type { IMessagesExpire } from "./services/messagesExpire/index.ts";
import { MessagesExpire } from "./services/messagesExpire/index.ts";
import type { IWebSocketServer } from "./services/webSocketServer/index.ts";
import { WebSocketServer } from "./services/webSocketServer/index.ts";
import { MessageHandler } from "./messageHandler/index.ts";
import { Api } from "./api/index.ts";
import type { IClient } from "./models/client.ts";
import type { IMessage } from "./models/message.ts";
import type { IConfig } from "./config/index.ts";
import { RedisAdapter } from "./adapters/redisAdapter.ts";

export interface PeerServerEvents {
	on(event: "connection", listener: (client: IClient) => void): this;
	on(
		event: "message",
		listener: (client: IClient, message: IMessage) => void,
	): this;
	// eslint-disable-next-line @typescript-eslint/unified-signatures
	on(event: "disconnect", listener: (client: IClient) => void): this;
	on(event: "error", listener: (client: Error) => void): this;
}

export const createInstance = ({
	app,
	server,
	options,
}: {
	app: express.Application;
	server: HttpServer | HttpsServer;
	options: IConfig;
}): void => {
	const config = options;
	const realm: IRealm = new Realm();

	let redisAdapter: RedisAdapter | undefined;
	if (config.redisOptions) {
		redisAdapter = new RedisAdapter({
			...config.redisOptions,
			ttl: config.redis_ttl,
		});
		realm.setRedisAdapter(redisAdapter);
	}

	const messageHandler = new MessageHandler(
		realm,
		undefined,
		redisAdapter,
		config.message_queue_enabled,
	);

	if (redisAdapter) {
		redisAdapter
			.subscribe((message) => {
				void (async () => {
					const { dst } = message;
					const client = realm.getClientById(dst);
					if (client) {
						// This pod has the target client!
						await messageHandler.handle(client, message);
					}
				})();
			})
			.catch((e) => {
				console.error("Redis subscribe error", e);
			});
	}

	const api = Api({ config, realm, corsOptions: options.corsOptions });
	const messagesExpire: IMessagesExpire = new MessagesExpire({
		realm,
		config,
		messageHandler,
	});
	const checkBrokenConnections = new CheckBrokenConnections({
		realm,
		config,
		onClose: (client) => {
			app.emit("disconnect", client);
		},
	});

	app.use(options.path, api);

	//use mountpath for WS server
	const customConfig = {
		...config,
		path: path.posix.join(app.path(), options.path, "/"),
	};

	const wss: IWebSocketServer = new WebSocketServer({
		server,
		realm,
		config: customConfig,
	});

	wss.on("connection", (client: IClient) => {
		void (async () => {
			if (config.message_queue_enabled) {
				if (redisAdapter) {
					const messages = await redisAdapter.getMessagesFromQueue(
						client.getId(),
					);
					for (const message of messages) {
						await messageHandler.handle(client, message);
					}
					await realm.clearMessageQueue(client.getId());
				} else {
					const messageQueue = realm.getMessageQueueById(client.getId());

					if (messageQueue) {
						let message: IMessage | undefined;

						while ((message = messageQueue.readMessage())) {
							await messageHandler.handle(client, message);
						}
						await realm.clearMessageQueue(client.getId());
					}
				}
			}

			app.emit("connection", client);
		})();
	});

	wss.on("message", (client: IClient, message: IMessage) => {
		void (async () => {
			app.emit("message", client, message);
			await messageHandler.handle(client, message);
		})();
	});

	wss.on("close", (client: IClient) => {
		app.emit("disconnect", client);
	});

	wss.on("error", (error: Error) => {
		app.emit("error", error);
	});

	if (config.message_queue_enabled) {
		messagesExpire.startMessagesExpiration();
	}
	checkBrokenConnections.start();
};
