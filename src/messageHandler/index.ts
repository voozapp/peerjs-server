import { MessageType } from "../enums.ts";
import { HeartbeatHandler, TransmissionHandler } from "./handlers/index.ts";
import type { IHandlersRegistry } from "./handlersRegistry.ts";
import { HandlersRegistry } from "./handlersRegistry.ts";
import type { IClient } from "../models/client.ts";
import type { IMessage } from "../models/message.ts";
import type { IRealm } from "../models/realm.ts";
import type { Handler } from "./handler.ts";
import type { IRedisAdapter } from "../adapters/redisAdapter.ts";

export interface IMessageHandler {
	handle(client: IClient | undefined, message: IMessage): Promise<boolean>;
}

export class MessageHandler implements IMessageHandler {
	constructor(
		realm: IRealm,
		private readonly handlersRegistry: IHandlersRegistry = new HandlersRegistry(),
		redisAdapter?: IRedisAdapter,
	) {
		const transmissionHandler: Handler = TransmissionHandler({
			realm,
			redisAdapter,
		});
		const heartbeatHandler: Handler = HeartbeatHandler;

		const handleTransmission: Handler = async (
			client: IClient | undefined,
			{ type, src, dst, payload }: IMessage,
		): Promise<boolean> => {
			return await transmissionHandler(client, {
				type,
				src,
				dst,
				payload,
			});
		};

		const handleHeartbeat = async (
			client: IClient | undefined,
			message: IMessage,
		) => await heartbeatHandler(client, message);

		this.handlersRegistry.registerHandler(
			MessageType.HEARTBEAT,
			handleHeartbeat,
		);
		this.handlersRegistry.registerHandler(
			MessageType.OFFER,
			handleTransmission,
		);
		this.handlersRegistry.registerHandler(
			MessageType.ANSWER,
			handleTransmission,
		);
		this.handlersRegistry.registerHandler(
			MessageType.CANDIDATE,
			handleTransmission,
		);
		this.handlersRegistry.registerHandler(
			MessageType.LEAVE,
			handleTransmission,
		);
		this.handlersRegistry.registerHandler(
			MessageType.EXPIRE,
			handleTransmission,
		);
	}

	public async handle(
		client: IClient | undefined,
		message: IMessage,
	): Promise<boolean> {
		return await this.handlersRegistry.handle(client, message);
	}
}
