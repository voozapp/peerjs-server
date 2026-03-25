# PeerJS Server – Architecture Memory Bank

> Last updated: 2026-03-24

---

## 1. What Redis Does (and Does NOT) Store

**Short answer: Redis does NOT store peer _connection_ state (socket handles, token, presence). It stores _pending messages_ (queued signaling) and acts as a _Pub/Sub bus_ between pods.**

| Redis Key / Channel       | Type            | Stores                                                          | TTL             |
| :------------------------ | :-------------- | :-------------------------------------------------------------- | :-------------- |
| `peerjs:messages`         | Pub/Sub Channel | Serialized `IMessage` objects broadcast between pods            | N/A (ephemeral) |
| `peerjs:queue:<clientId>` | Redis List      | Queued `IMessage[]` for a client that is offline/on another pod | 24 hours        |

There is no Redis key for peer registration, socket handles, tokens, or last-ping timestamps.

---

## 2. What Each Layer Stores

### 2a. In-Memory (Per Pod) – `Realm` class (`src/models/realm.ts`)

```
clients: Map<clientId, IClient>
  └─ id: string            ← peer ID
  └─ token: string         ← auth token (validated on reconnect)
  └─ socket: WebSocket     ← live socket handle (null when disconnected)
  └─ lastPing: number      ← timestamp of last HEARTBEAT
messageQueues: Map<clientId, IMessageQueue>   ← only used when Redis is OFF
```

- **Cleared when pod dies.**
- Each pod only knows about peers _currently connected to it_.
- **Consequence**: `getClientsIds()` (the `/peers` discovery API) returns only local peer IDs for that pod.

### 2b. Redis – `RedisAdapter` (`src/adapters/redisAdapter.ts`)

```
peerjs:queue:<clientId>  → Redis List of JSON-encoded IMessage[]
peerjs:messages          → Pub/Sub channel (all pods subscribe)
```

- **Persists across pod restarts** (24-hour TTL).
- Used for both offline delivery and cross-pod signaling.

---

## 3. Distributed Logic & Performance Trade-offs

This fork prioritizes **low-latency signaling** for real-time applications (like random matching platforms) over strict offline persistence.

### 3a. Presence (Why not in Redis?)

- **Performance**: Storing presence in Redis would require a RTT (Round Trip Time) call on every connection, heartbeat, and disconnection.
- **Complexity**: It requires a cluster-wide heartbeat/expiry mechanism to avoid "ghost" peers when pods crash.
- **Current State**: Presence is kept in memory. Peer discovery is local to each pod.

### 3b. Reliable Signaling (Broadcast vs Queueing)

- **Standard PeerJS**: Queues any message that can't be delivered to a live socket.
- **This Redis Fork**:
  - If a peer is on Pod A, it sends immediately.
  - If NOT on Pod A, it **broadcasts** to the cluster.
  - If ANY pod has the peer, it delivers via WebSocket.
  - **The "Drop" Gap**: If NO pod has the peer (they are transiently offline or switching nodes), the message is currently dropped rather than queued. This ensures the system stays fast and focused on active users.

---

## 4. Component Map

```
src/
├── adapters/
│   └── redisAdapter.ts        ← RedisAdapter (pub + sub ioredis clients, queue ops)
├── config/
│   └── index.ts               ← IConfig (includes optional redisOptions)
├── enums.ts                   ← MessageType, Errors
├── instance.ts                ← App bootstrap: wires Redis, WSS, MessageHandler
├── messageHandler/
│   ├── index.ts               ← MessageHandler (routes by MessageType)
│   ├── handlersRegistry.ts    ← Registry pattern for type→handler mapping
│   └── handlers/
│       ├── heartbeat/         ← Updates client.lastPing
│       └── transmission/      ← Core routing logic (local → socket, cross-pod → Redis publish, offline → queue)
├── models/
│   ├── client.ts              ← Client (id, token, socket, lastPing)
│   ├── message.ts             ← IMessage (type, src, dst, payload)
│   ├── messageQueue.ts        ← In-memory queue (used without Redis)
│   └── realm.ts               ← Realm (in-memory peer registry, delegates queue to Redis if available)
└── services/
    ├── checkBrokenConnections/ ← Polls every 300ms; evicts peers with lastPing > alive_timeout (90s)
    ├── messagesExpire/         ← Polls every cleanup_out_msgs (1s); sends EXPIRE for stale in-mem queues
    └── webSocketServer/        ← Handles WS lifecycle: connect, register, message, close
```

---

## 5. Message Routing Flow

```
Client A (on Pod 1) sends OFFER to Client B
        │
        ▼
WebSocketServer.on("message")
        │
        ▼
MessageHandler.handle()
        │
        ▼
TransmissionHandler
        │
        ├─ realm.getClientById(dst) → found on THIS pod?
        │       YES → socket.send() directly
        │       NO  ↓
        │
        ├─ redisAdapter present AND message not already a broadcast?
        │       YES → redisAdapter.publish({ ...message, _broadcast: true })
        │              └─ All pods receive it on "peerjs:messages"
        │                    └─ Each pod checks: realm.getClientById(dst)?
        │                          found → messageHandler.handle(client, msg) → socket.send()
        │                          not found → skip (drop)
        │       NO  ↓
        │
        └─ Queue message: realm.addMessageToQueue(dst, message)
               └─ Redis mode: rpush peerjs:queue:<dst>, expire 24h
               └─ In-mem mode: messageQueues.set(dst, new MessageQueue())
```

> ⚠️ **Note**: In Redis mode, the queue fallback (line 104) is currently only reached if the message was ALREADY a broadcast that failed everywhere. However, `instance.ts` currently doesn't re-invoke `TransmissionHandler` if the client isn't found during a broadcast, so messages for offline clients are effectively dropped in multi-pod mode.

---

## 6. Client Connection Lifecycle

```
New WS connection arrives at pod
        │
        ├─ Parse ?id=&token=&key= from URL
        ├─ Validate key matches config
        │
        ├─ realm.getClientById(id)?
        │       found → validate token → setSocket() on existing client (reconnect path)
        │               └─ configureWS(): attach message/close handlers
        │       not found → _registerClient(): new Client(id, token), realm.setClient()
        │
        ▼
wss.emit("connection", client)
        │
        ├─ Redis mode: getMessagesFromQueue(id) → deliver → clearMessageQueue(id)
        └─ In-mem mode: messageQueue.readMessage() loop → deliver → clearMessageQueue(id)

WS close event
        └─ realm.removeClientById(id)   ← evicts from in-memory map; Redis queue untouched
```

---

## 7. Key Config Values

| Config Key              | Default  | Purpose                                                                                                          |
| :---------------------- | :------- | :--------------------------------------------------------------------------------------------------------------- |
| `alive_timeout`         | 60,000ms | Max age without HEARTBEAT before client is evicted                                                               |
| `concurrent_limit`      | 5,000    | Max concurrent peers per pod                                                                                     |
| `message_queue_enabled` | `true`   | Enable message queueing (persistence/offline support). Set ENV `MESSAGE_QUEUE_ENABLED=false` to disable.         |
| `redis_ttl`             | `86400`  | Redis message queue TTL in seconds. Set ENV `REDIS_TTL`.                                                         |
| `redisOptions.host`     | –        | Redis host; enables Redis mode when set                                                                          |
| `redisOptions.port`     | –        | Redis port                                                                                                       |
| `redisOptions.password` | –        | Redis auth                                                                                                       |
| `redisOptions.tls`      | `false`  | Enable TLS encryption for secure Redis connections (required for Azure Managed Redis). Set ENV `REDIS_TLS=true`. |

---

## 8. Pod Death Scenario (K8s Rescheduling)

When a pod is killed:

1. **In-memory peer map → LOST.** Peer connection state is gone.
2. **Redis message queues → SURVIVE.** `peerjs:queue:<id>` lists remain for 24h.
3. **Pub/Sub subscription → DROPPED.**
4. **Peer reconnects to a new pod:** Picks up any messages that were explicitly queued before the pod death or during a single-pod failover.

---

## 8. File Reference Quick-Map

| Question                         | File                                                |
| :------------------------------- | :-------------------------------------------------- |
| How does Redis connect?          | `src/adapters/redisAdapter.ts`                      |
| Where is a peer stored?          | `src/models/realm.ts` (`clients` Map)               |
| How are messages queued?         | `src/models/realm.ts` → `addMessageToQueue()`       |
| What is a Client?                | `src/models/client.ts`                              |
| How does routing work?           | `src/messageHandler/handlers/transmission/index.ts` |
| How does a WS connection open?   | `src/services/webSocketServer/index.ts`             |
| How are dead clients evicted?    | `src/services/checkBrokenConnections/index.ts`      |
| How are stale queues expired?    | `src/services/messagesExpire/index.ts`              |
| Where is the app wired together? | `src/instance.ts`                                   |
| Config options?                  | `src/config/index.ts`                               |
