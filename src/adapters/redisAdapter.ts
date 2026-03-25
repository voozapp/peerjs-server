import { Redis } from "ioredis";
import type { IMessage } from "../models/message.ts";

export interface IRedisAdapter {
	publish(message: IMessage): Promise<void>;
	subscribe(callback: (message: IMessage) => void): Promise<void>;
	addMessageToQueue(clientId: string, message: IMessage): Promise<void>;
	getMessagesFromQueue(clientId: string): Promise<IMessage[]>;
	clearMessageQueue(clientId: string): Promise<void>;
}

export class RedisAdapter implements IRedisAdapter {
	private readonly pub: Redis;
	private readonly sub: Redis;
	private readonly channel = "peerjs:messages";
	private readonly queuePrefix = "peerjs:queue:";
	private readonly ttl: number;

	constructor(options: {
		host?: string;
		port?: number;
		password?: string;
		keyPrefix?: string;
		ttl?: number;
		tls?: Record<string, unknown>;
	}) {
		this.pub = new Redis({
			...options,
		});
		this.sub = new Redis({
			...options,
		});
		this.ttl = options.ttl ?? 24 * 60 * 60;
	}

	public async publish(message: IMessage): Promise<void> {
		await this.pub.publish(this.channel, JSON.stringify(message));
	}

	public async subscribe(callback: (message: IMessage) => void): Promise<void> {
		await this.sub.subscribe(this.channel);
		this.sub.on("message", (channel, message) => {
			if (channel === this.channel) {
				try {
					const parsedMessage = JSON.parse(message) as IMessage;
					callback(parsedMessage);
				} catch (e) {
					console.error("Failed to parse redis message", e);
				}
			}
		});
	}

	public async addMessageToQueue(
		clientId: string,
		message: IMessage,
	): Promise<void> {
		const key = `${this.queuePrefix}${clientId}`;
		await this.pub.rpush(key, JSON.stringify(message));
		await this.pub.expire(key, this.ttl);
	}

	public async getMessagesFromQueue(clientId: string): Promise<IMessage[]> {
		const key = `${this.queuePrefix}${clientId}`;
		const messages = await this.pub.lrange(key, 0, -1);
		return messages.map((m) => JSON.parse(m) as IMessage);
	}

	public async clearMessageQueue(clientId: string): Promise<void> {
		const key = `${this.queuePrefix}${clientId}`;
		await this.pub.del(key);
	}
}
