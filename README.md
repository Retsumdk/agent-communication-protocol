# Agent Communication Protocol (ACP)

> Inter-agent message passing protocol with delivery guarantees, acknowledgment receipts, and priority queuing

**Built by [Retsumdk](https://github.com/Retsumdk)**

## Overview

ACP is a robust message passing system designed for AI agent networks. It provides at-least-once delivery semantics with priority-based queuing, acknowledgment receipts, and persistent message storage.

## Features

- **At-Least-Once Delivery** — Messages are retried until acknowledged or expired
- **Priority Queuing** — Critical, high, normal, and low priority message handling
- **Acknowledgment Receipts** — Delivery confirmation with latency tracking
- **Message Persistence** — Disk-backed message store for crash recovery
- **Priority Queue** — Sorted queue ensuring critical messages are processed first
- **Concurrent Delivery** — Configurable parallel message delivery
- **Retry Logic** — Exponential backoff with configurable retry limits
- **Event Emitters** — Full event system for monitoring message lifecycle

## Installation

```bash
bun add @retsumdk/agent-communication-protocol
```

## Quick Start

```typescript
import { AgentCommunicationProtocol } from "@retsumdk/agent-communication-protocol";

// Create protocol instance for your agent
const protocol = new AgentCommunicationProtocol("my-agent-id", {
  storePath: "./.acp-messages",  // Optional: persistence directory
  maxRetries: 3,                  // Max delivery attempts
  retryDelayMs: 1000,             // Base retry delay
  ackTimeoutMs: 30000,            // Acknowledgment timeout
  maxConcurrentDeliveries: 10,   // Parallel deliveries
});

// Start the protocol
protocol.start();

// Listen for events
protocol.on("message-acknowledged", (ack) => {
  console.log(`Message ${ack.messageId} delivered in ${ack.latencyMs}ms`);
});

protocol.on("message-delivery-failed", (messageId, error) => {
  console.error(`Failed to deliver ${messageId}: ${error}`);
});

// Send a message
const messageId = await protocol.send(
  { agentId: "recipient-agent" },
  { action: "process", data: "hello" },
  { priority: "high" }
);

console.log(`Sent message: ${messageId}`);
```

## API Reference

### `AgentCommunicationProtocol`

#### Constructor

```typescript
new AgentCommunicationProtocol(localAgentId: string, config?: ProtocolConfig)
```

**Parameters:**
- `localAgentId` — Unique identifier for this agent
- `config` — Optional configuration object

**Config Options:**
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `storePath` | `string` | `./.acp-messages` | Message persistence directory |
| `maxRetries` | `number` | `3` | Maximum delivery attempts |
| `retryDelayMs` | `number` | `1000` | Base delay between retries |
| `ackTimeoutMs` | `number` | `30000` | Acknowledgment timeout |
| `maxConcurrentDeliveries` | `number` | `10` | Parallel delivery limit |

#### Methods

##### `start()`

Start the protocol engine. Must be called before sending messages.

```typescript
protocol.start();
```

##### `stop()`

Stop the protocol engine.

```typescript
protocol.stop();
```

##### `send(to, payload, options?)`

Send a message to a destination agent.

```typescript
async send(
  to: AgentAddress,
  payload: unknown,
  options?: {
    priority?: MessagePriority;  // "critical" | "high" | "normal" | "low"
    expiresAt?: number;          // Unix timestamp
    correlationId?: string;      // For correlating request/response
    headers?: Record<string, string>;
    onAcknowledged?: (ack: Acknowledgment) => void;
  }
): Promise<string>  // Returns messageId
```

##### `sendBatch(messages)`

Send multiple messages in order.

```typescript
async sendBatch(messages: Array<{
  to: AgentAddress;
  payload: unknown;
  priority?: MessagePriority;
  expiresAt?: number;
}>): Promise<string[]>
```

##### `acknowledge(messageId, details?)`

Acknowledge receipt of a message (called by recipient).

```typescript
acknowledge(messageId: string, details?: string): Acknowledgment
```

##### `getMessageStatus(messageId)`

Get current delivery status.

```typescript
getMessageStatus(messageId: string): DeliveryReceipt | null
```

##### `getPendingMessages()`

Get all pending messages.

```typescript
getPendingMessages(): MessageEnvelope[]
```

##### `retryMessage(messageId, priority?)`

Retry a failed message.

```typescript
retryMessage(messageId: string, priority?: MessagePriority): boolean
```

##### `cancelMessage(messageId)`

Cancel a pending message.

```typescript
cancelMessage(messageId: string): boolean
```

##### `getStats()`

Get protocol statistics.

```typescript
getStats(): {
  totalMessages: number;
  pending: number;
  acknowledged: number;
  failed: number;
  pendingAcks: number;
  activeDeliveries: number;
  queueSize: number;
}
```

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `started` | `agentId` | Protocol started |
| `stopped` | `agentId` | Protocol stopped |
| `message-sent` | `messageId, message` | Message queued for delivery |
| `message-acknowledged` | `ack` | Delivery acknowledged |
| `message-delivered` | `messageId, receipt` | Message successfully delivered |
| `message-delivery-failed` | `messageId, error` | Delivery failed after all retries |
| `message-expired` | `messageId` | Message expired before ack |

## CLI Usage

```bash
# Send a message
bun run acp send --to agent-123 --payload '{"action":"hello"}' --priority high

# Acknowledge a message
bun run acp ack --id <messageId> --details "Received successfully"

# Check message status
bun run acp status --id <messageId>

# Show statistics
bun run acp stats
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    AgentCommunicationProtocol                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐   │
│  │ MessageStore │───▶│ DeliveryAgent│───▶│ AcknowledgmentMgr │   │
│  └──────────────┘    └──────────────┘    └──────────────────┘   │
│         │                   │                      │             │
│         │                   │                      │             │
│         ▼                   ▼                      ▼             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐   │
│  │ PriorityQueue│    │ MessageQueue │    │ PendingAcks Map  │   │
│  └──────────────┘    └──────────────┘    └──────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Components

**MessageStore** — Disk-backed persistence for all messages and delivery receipts

**PriorityQueue** — Sorted queue ensuring critical/high priority messages are processed first

**DeliveryAgent** — Manages concurrent message delivery with retry logic

**AcknowledgmentManager** — Tracks pending acknowledgments and handles timeouts

## Message Flow

1. **Send** — Message is created, stored, and enqueued with priority
2. **Queue** — PriorityQueue sorts by priority (critical → low)
3. **Deliver** — DeliveryAgent processes queue with configurable concurrency
4. **Retry** — On failure, message is retried with exponential backoff
5. **Acknowledge** — Recipient calls `acknowledge()` to confirm receipt
6. **Complete** — Delivery receipt is updated and event is emitted

## Priority Levels

| Level | Numeric | Use Case |
|-------|---------|----------|
| `critical` | 0 | System alerts, shutdown signals |
| `high` | 1 | Urgent tasks, time-sensitive data |
| `normal` | 2 | Standard agent communications |
| `low` | 3 | Background sync, low-priority updates |

## Delivery Guarantees

- **At-Least-Once** — Messages are delivered at least once, may be duplicated
- **Ordered by Priority** — Critical messages are always processed first
- **Persistent** — Messages survive protocol restarts
- **Timeout Handling** — Unacknowledged messages expire after configurable timeout

## License

MIT © Retsumdk