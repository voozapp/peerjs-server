# Goal Description

The Vooz product currently relies on a single-pod PeerJS server because `peerjs-server` holds the client connections (WebSocket) and message queues in memory. When a client connects to Pod A and tries to signal a client connected to Pod B, Pod A doesn't know about the client on Pod B, and the handshake fails. Also, when the single pod goes down, signaling goes down. 

To solve this and enable horizontal scaling (multiple pods), we need to introduce a shared state and messaging layer across pods using **Redis**.

The solution involves:
1. **Redis Pub/Sub** for routing real-time signaling messages across pods.
2. **Redis-backed Queues** (Lists/Hashes) to replace the in-memory queue for offline delivery.
3. Updating the routing logic in `peerjs-server` to leverage this Redis adapter.

## User Review Required

> [!WARNING]
> This requires adding a new dependency (`ioredis`) to `peerjs-server`.
> Also, please confirm if you have a Redis instance already available in your infrastructure (or if I should add it to a `docker-compose.yml` if applicable).

## Proposed Changes

### `peerjs-server` Configurations

#### [MODIFY] [package.json](file:///Users/ayush/Developer/vooz/code/vooz-client/peerjs-server/package.json)
- Add `ioredis` to dependencies.

#### [MODIFY] [src/config/index.ts](file:///Users/ayush/Developer/vooz/code/vooz-client/peerjs-server/src/config/index.ts)
- Add optional `redisOptions` or a `redisUrl` configuration property to enable multi-pod mode.

---

### `peerjs-server` Redis Adapter

#### [NEW] `src/adapters/redisAdapter.ts`
- Implement a class `RedisAdapter` that manages two Redis connections (one for publishing/commands, one for subscribing).
- Implement methods to subscribe to a `peerjs:messages` channel.
- Implement methods to read/write/clear message queues stored in Redis (e.g., `peerjs:queue:{clientId}`).

#### [MODIFY] [src/instance.ts](file:///Users/ayush/Developer/vooz/code/vooz-client/peerjs-server/src/instance.ts)
- Initialize the `RedisAdapter` if `redis` config is provided.
- Bind the Redis adapter to listen for cross-pod messages and route them to the local `messageHandler` if the target client is connected to the active pod.
- Pass the adapter instance to `Realm` or `MessageHandler` as a dependency.

---

### `peerjs-server` State & Routing

#### [MODIFY] [src/models/realm.ts](file:///Users/ayush/Developer/vooz/code/vooz-client/peerjs-server/src/models/realm.ts)
- Expand `IRealm` and `Realm` to interact with `RedisAdapter` (if available) for message queueing (`addMessageToQueue`, `getMessageQueueById`, `clearMessageQueue`). Fall back to in-memory `messageQueues` if Redis is not configured.
- (Optional) Modify client registry to store client presence in Redis, though Pub/Sub broadcast might be sufficent without a global directory.

#### [MODIFY] [src/messageHandler/handlers/transmission/index.ts](file:///Users/ayush/Developer/vooz/code/vooz-client/peerjs-server/src/messageHandler/handlers/transmission/index.ts)
- Currently, if `destinationClient` is not found, it puts the message in the local realm's queue.
- Change: If `destinationClient` is not found, it should publish the message to the `RedisAdapter` (`peerjs:messages`).
- The message includes `{ src, dst, payload, type }`. Other pods listening to `peerjs:messages` will check if they hold `dst`. If they do, they send it via their WebSocket. If no pod holds it, we can queue it in Redis.

## Verification Plan

### Automated Tests
- N/A for this layer directly unless there are existing test suites in `peerjs-server` that mock Redis. We will run `npm run test` inside `peerjs-server` to ensure no existing tests are broken.

### Manual Verification
1. Run two instances of `peerjs-server` locally on different ports (e.g., 9000 and 9001) connected to the same local Redis server.
2. Initialize two PeerJS clients, one connecting to 9000 and the other to 9001.
3. Attempt to establish a WebRTC connection (call/send data) between the two clients.
4. Verify the handshake completes successfully across the two different pods.
