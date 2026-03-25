import type { WebSocketServer, ServerOptions } from "ws";
import type { CorsOptions } from "cors";

export interface IConfig {
	readonly host: string;
	readonly port: number;
	readonly expire_timeout: number;
	readonly alive_timeout: number;
	readonly key: string;
	readonly path: string;
	readonly concurrent_limit: number;
	readonly allow_discovery: boolean;
	readonly proxied: boolean | string;
	readonly cleanup_out_msgs: number;
	readonly ssl?: {
		readonly key: string;
		readonly cert: string;
	};
	readonly generateClientId?: () => string;
	readonly createWebSocketServer?: (options: ServerOptions) => WebSocketServer;
	readonly corsOptions: CorsOptions;
	readonly redisOptions?: {
		readonly host?: string;
		readonly port?: number;
		readonly password?: string;
		readonly keyPrefix?: string;
		readonly tls?: Record<string, unknown>;
	};
	readonly message_queue_enabled: boolean;
	readonly redis_ttl: number;
}

const defaultConfig: IConfig = {
	host: "::",
	port: 9000,
	expire_timeout: 5000,
	alive_timeout: 90000,
	key: "peerjs",
	path: "/",
	concurrent_limit: 5000,
	allow_discovery: false,
	proxied: false,
	cleanup_out_msgs: 1000,
	corsOptions: { origin: true },
	message_queue_enabled: true,
	redis_ttl: 24 * 60 * 60, // 24 hours
};

export default defaultConfig;
