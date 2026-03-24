import { MessageType } from "../../../enums.ts";
import type { IClient } from "../../../models/client.ts";
import type { IMessage } from "../../../models/message.ts";
import type { IRealm } from "../../../models/realm.ts";
import type { IRedisAdapter } from "../../../adapters/redisAdapter.ts";

export const TransmissionHandler = ({
	realm,
	redisAdapter,
}: {
	realm: IRealm;
	redisAdapter?: IRedisAdapter;
}): ((client: IClient | undefined, message: IMessage) => Promise<boolean>) => {
	const handle = async (client: IClient | undefined, message: IMessage): Promise<boolean> => {
		const type = message.type;
		const srcId = message.src;
		const dstId = message.dst;

		const destinationClient = realm.getClientById(dstId);

		// User is connected to THIS pod!
		if (destinationClient) {
			const socket = destinationClient.getSocket();
			try {
				if (socket) {
					const data = JSON.stringify(message);

					socket.send(data);
				} else {
					// Neither socket no res available. Peer dead?
					throw new Error("Peer dead");
				}
			} catch (e) {
				// This happens when a peer disconnects without closing connections and
				// the associated WebSocket has not closed.
				// Tell other side to stop trying.
				if (socket) {
					socket.close();
				} else {
					realm.removeClientById(destinationClient.getId());
				}

				await handle(client, {
					type: MessageType.LEAVE,
					src: dstId,
					dst: srcId,
				});
			}
		} else {
			// If we have a redis adapter, publish to other pods
			// But we must check if this message was already a redis-broadcast to avoid loops
			// We can adding a flag to the message or use a specific source pod ID, 
			// but a simpler way is to check if we are the "source" pod for this client.
			// Actually, if we are here and destinationClient is null, it means the client is NOT on this pod.
			
			// To avoid infinite loops: only publish IF the message didn't come FROM redis.
			// However, our RedisAdapter doesn't mark messages. 
			// Let's add an internal property `_broadcast` to the message when publishing.
			
			if (redisAdapter && !(message as any)._broadcast) {
				await redisAdapter.publish({ ...message, _broadcast: true } as any);
			} else {
				// Wait for this client to connect/reconnect (XHR) for important
				// messages.
				const ignoredTypes = [MessageType.LEAVE, MessageType.EXPIRE];

				if (!ignoredTypes.includes(type) && dstId) {
					await realm.addMessageToQueue(dstId, message);
				} else if (type === MessageType.LEAVE && !dstId) {
					realm.removeClientById(srcId);
				}
			}
		}

		return true;
	};

	return handle;
};
