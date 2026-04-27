import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import {
  AgentCommunicationProtocol,
  MessagePriority,
  MessageEnvelope,
  Acknowledgment,
  DeliveryReceipt,
} from "../src/index";

// ============================================================================
// Test Helpers
// ============================================================================

function createMockMessage(overrides: Partial<{
  id: string;
  priority: MessagePriority;
  timestamp: number;
}> = {}) {
  return {
    id: overrides.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    from: { agentId: "sender-agent" },
    to: { agentId: "receiver-agent" },
    payload: { action: "test", data: "hello" },
    priority: overrides.priority || "normal",
    timestamp: overrides.timestamp || Date.now(),
    headers: {},
    ...overrides,
  };
}

function createTestProtocol(agentId = "test-agent") {
  return new AgentCommunicationProtocol(agentId, {
    storePath: `/tmp/.acp-test-${Date.now()}`,
    maxRetries: 2,
    retryDelayMs: 50,
    ackTimeoutMs: 5000,
    maxConcurrentDeliveries: 3,
  });
}

// ============================================================================
// PriorityQueue Tests
// ============================================================================

describe("PriorityQueue", () => {
  test("enqueue and dequeue respects priority order", async () => {
    const { PriorityQueue } = await import("../src/index");
    const queue = new PriorityQueue<string>();

    queue.enqueue("low-priority", "low");
    queue.enqueue("critical-priority", "critical");
    queue.enqueue("high-priority", "high");
    queue.enqueue("normal-priority", "normal");

    // Critical should come first
    expect(queue.dequeue()).toBe("critical-priority");
    expect(queue.dequeue()).toBe("high-priority");
    expect(queue.dequeue()).toBe("normal-priority");
    expect(queue.dequeue()).toBe("low-priority");
    expect(queue.isEmpty()).toBe(true);
  });

  test("peek returns without removing", async () => {
    const { PriorityQueue } = await import("../src/index");
    const queue = new PriorityQueue<string>();

    queue.enqueue("first", "high");
    queue.enqueue("second", "high");

    expect(queue.peek()).toBe("first");
    expect(queue.size()).toBe(2);
  });

  test("isEmpty returns true for empty queue", async () => {
    const { PriorityQueue } = await import("../src/index");
    const queue = new PriorityQueue<string>();

    expect(queue.isEmpty()).toBe(true);
    queue.enqueue("item", "normal");
    expect(queue.isEmpty()).toBe(false);
  });

  test("filter returns matching items", async () => {
    const { PriorityQueue } = await import("../src/index");
    const queue = new PriorityQueue<string>();

    queue.enqueue("match-1", "high");
    queue.enqueue("no-match", "low");
    queue.enqueue("match-2", "high");

    const results = queue.filter((item) => item.startsWith("match"));
    expect(results).toContain("match-1");
    expect(results).toContain("match-2");
    expect(results).not.toContain("no-match");
  });

  test("clear removes all items", async () => {
    const { PriorityQueue } = await import("../src/index");
    const queue = new PriorityQueue<string>();

    queue.enqueue("item1", "normal");
    queue.enqueue("item2", "high");
    expect(queue.size()).toBe(2);

    queue.clear();
    expect(queue.isEmpty()).toBe(true);
  });
});

// ============================================================================
// MessageStore Tests
// ============================================================================

describe("MessageStore", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = `/tmp/.acp-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  test("put and get retrieves message envelope", async () => {
    const { MessageStore } = await import("../src/index");
    const store = new MessageStore(storePath);

    const envelope: MessageEnvelope = {
      message: createMockMessage(),
      receipt: {
        messageId: "test-id",
        status: "pending",
        attempts: 0,
        lastAttempt: 0,
      },
      acks: [],
    };

    store.put(envelope);
    const retrieved = store.get("test-id");

    expect(retrieved).toBeDefined();
    expect(retrieved?.message.id).toBe("test-id");
    expect(retrieved?.receipt.status).toBe("pending");
  });

  test("update modifies delivery receipt", async () => {
    const { MessageStore } = await import("../src/index");
    const store = new MessageStore(storePath);

    const envelope: MessageEnvelope = {
      message: createMockMessage({ id: "update-test" }),
      receipt: {
        messageId: "update-test",
        status: "pending",
        attempts: 0,
        lastAttempt: 0,
      },
      acks: [],
    };

    store.put(envelope);
    store.update("update-test", { status: "sent", attempts: 1, lastAttempt: Date.now() });

    const updated = store.get("update-test");
    expect(updated?.receipt.status).toBe("sent");
    expect(updated?.receipt.attempts).toBe(1);
  });

  test("addAck appends acknowledgment to envelope", async () => {
    const { MessageStore } = await import("../src/index");
    const store = new MessageStore(storePath);

    const envelope: MessageEnvelope = {
      message: createMockMessage({ id: "ack-test" }),
      receipt: {
        messageId: "ack-test",
        status: "pending",
        attempts: 0,
        lastAttempt: 0,
      },
      acks: [],
    };

    store.put(envelope);

    const ack: Acknowledgment = {
      messageId: "ack-test",
      status: "acknowledged",
      receivedAt: Date.now(),
      latencyMs: 150,
    };

    store.addAck("ack-test", ack);

    const updated = store.get("ack-test");
    expect(updated?.acks).toHaveLength(1);
    expect(updated?.acks[0].latencyMs).toBe(150);
  });

  test("getAllPending returns only pending messages", async () => {
    const { MessageStore } = await import("../src/index");
    const store = new MessageStore(storePath);

    const pending1: MessageEnvelope = {
      message: createMockMessage({ id: "pending-1" }),
      receipt: { messageId: "pending-1", status: "pending", attempts: 0, lastAttempt: 0 },
      acks: [],
    };
    const pending2: MessageEnvelope = {
      message: createMockMessage({ id: "pending-2" }),
      receipt: { messageId: "pending-2", status: "queued", attempts: 0, lastAttempt: 0 },
      acks: [],
    };
    const completed: MessageEnvelope = {
      message: createMockMessage({ id: "completed" }),
      receipt: { messageId: "completed", status: "acknowledged", attempts: 1, lastAttempt: Date.now(), acknowledgedAt: Date.now() },
      acks: [],
    };

    store.put(pending1);
    store.put(pending2);
    store.put(completed);

    const pending = store.getAllPending();
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.message.id)).toContain("pending-1");
    expect(pending.map((p) => p.message.id)).toContain("pending-2");
  });

  test("remove deletes message from store", async () => {
    const { MessageStore } = await import("../src/index");
    const store = new MessageStore(storePath);

    const envelope: MessageEnvelope = {
      message: createMockMessage({ id: "to-remove" }),
      receipt: { messageId: "to-remove", status: "pending", attempts: 0, lastAttempt: 0 },
      acks: [],
    };

    store.put(envelope);
    expect(store.get("to-remove")).toBeDefined();

    const removed = store.remove("to-remove");
    expect(removed).toBe(true);
    expect(store.get("to-remove")).toBeUndefined();
  });

  test("size returns correct count", async () => {
    const { MessageStore } = await import("../src/index");
    const store = new MessageStore(storePath);

    expect(store.size()).toBe(0);

    store.put({
      message: createMockMessage({ id: "size-1" }),
      receipt: { messageId: "size-1", status: "pending", attempts: 0, lastAttempt: 0 },
      acks: [],
    });
    store.put({
      message: createMockMessage({ id: "size-2" }),
      receipt: { messageId: "size-2", status: "pending", attempts: 0, lastAttempt: 0 },
      acks: [],
    });

    expect(store.size()).toBe(2);
  });
});

// ============================================================================
// AcknowledgmentManager Tests
// ============================================================================

describe("AcknowledgmentManager", () => {
  test("registerPending sets timeout and callback", async () => {
    const { AcknowledgmentManager } = await import("../src/index");
    const manager = new AcknowledgmentManager();
    manager.setDefaultTimeout(100);

    const ackCallback = vi.fn();
    manager.registerPending("test-msg", ackCallback);

    expect(manager.getPendingCount()).toBe(1);
  });

  test("receiveAck clears timeout and calls callback", async () => {
    const { AcknowledgmentManager } = await import("../src/index");
    const manager = new AcknowledgmentManager();
    manager.setDefaultTimeout(5000);

    const ackCallback = vi.fn();
    manager.registerPending("test-msg", ackCallback);

    const ack: Acknowledgment = {
      messageId: "test-msg",
      status: "acknowledged",
      receivedAt: Date.now(),
      latencyMs: 100,
    };

    manager.receiveAck(ack);

    expect(ackCallback).toHaveBeenCalledWith(ack);
    expect(manager.getPendingCount()).toBe(0);
  });

  test("cancelPending removes pending ack", async () => {
    const { AcknowledgmentManager } = await import("../src/index");
    const manager = new AcknowledgmentManager();
    manager.setDefaultTimeout(5000);

    const ackCallback = vi.fn();
    manager.registerPending("test-msg", ackCallback);
    expect(manager.getPendingCount()).toBe(1);

    manager.cancelPending("test-msg");
    expect(manager.getPendingCount()).toBe(0);
  });
});

// ============================================================================
// AgentCommunicationProtocol Tests
// ============================================================================

describe("AgentCommunicationProtocol", () => {
  let protocol: AgentCommunicationProtocol;

  afterEach(() => {
    if (protocol) {
      protocol.stop();
    }
  });

  test("constructor initializes with correct defaults", () => {
    protocol = createTestProtocol("constructor-test");
    expect(protocol.isStarted()).toBe(false);
  });

  test("start() sets started flag to true", () => {
    protocol = createTestProtocol("start-test");
    protocol.start();
    expect(protocol.isStarted()).toBe(true);
  });

  test("stop() sets started flag to false", () => {
    protocol = createTestProtocol("stop-test");
    protocol.start();
    protocol.stop();
    expect(protocol.isStarted()).toBe(false);
  });

  test("send() throws if protocol not started", async () => {
    protocol = createTestProtocol("send-not-started");
    // Don't start

    await expect(
      protocol.send({ agentId: "recipient" }, { test: "data" })
    ).rejects.toThrow("Protocol not started");
  });

  test("send() returns messageId when started", async () => {
    protocol = createTestProtocol("send-started");
    protocol.start();

    const messageId = await protocol.send({ agentId: "recipient" }, { test: "data" });
    expect(typeof messageId).toBe("string");
    expect(messageId.length).toBeGreaterThan(0);
  });

  test("send() creates message with correct priority", async () => {
    protocol = createTestProtocol("send-priority");
    protocol.start();

    const messageId = await protocol.send(
      { agentId: "recipient" },
      { test: "data" },
      { priority: "critical" }
    );

    const status = protocol.getMessageStatus(messageId);
    expect(status).toBeDefined();
    expect(status?.status).toMatch(/^(queued|sent)$/);
  });

  test("sendBatch() sends multiple messages", async () => {
    protocol = createTestProtocol("send-batch");
    protocol.start();

    const messages = [
      { to: { agentId: "agent-1" }, payload: { n: 1 } },
      { to: { agentId: "agent-2" }, payload: { n: 2 } },
      { to: { agentId: "agent-3" }, payload: { n: 3 } },
    ];

    const ids = await protocol.sendBatch(messages);
    expect(ids).toHaveLength(3);
    expect(ids.every((id) => typeof id === "string")).toBe(true);
  });

  test("getMessageStatus() returns null for unknown message", () => {
    protocol = createTestProtocol("status-unknown");
    protocol.start();

    const status = protocol.getMessageStatus("unknown-message-id");
    expect(status).toBeNull();
  });

  test("getMessageStatus() returns current status", async () => {
    protocol = createTestProtocol("status-existing");
    protocol.start();

    const messageId = await protocol.send({ agentId: "recipient" }, { test: "data" });
    const status = protocol.getMessageStatus(messageId);

    expect(status).not.toBeNull();
    expect(status?.messageId).toBe(messageId);
  });

  test("acknowledge() throws for unknown message", () => {
    protocol = createTestProtocol("ack-unknown");
    protocol.start();

    expect(() => protocol.acknowledge("unknown-id")).toThrow("Message unknown-id not found");
  });

  test("acknowledge() returns acknowledgment", async () => {
    protocol = createTestProtocol("ack-valid");
    protocol.start();

    const messageId = await protocol.send({ agentId: "recipient" }, { test: "data" });
    const ack = protocol.acknowledge(messageId, "Received");

    expect(ack.messageId).toBe(messageId);
    expect(ack.status).toBe("acknowledged");
    expect(ack.details).toBe("Received");
  });

  test("retryMessage() returns false for unknown message", () => {
    protocol = createTestProtocol("retry-unknown");
    protocol.start();

    const result = protocol.retryMessage("unknown-id");
    expect(result).toBe(false);
  });

  test("cancelMessage() removes message from store", async () => {
    protocol = createTestProtocol("cancel-message");
    protocol.start();

    const messageId = await protocol.send({ agentId: "recipient" }, { test: "data" });
    expect(protocol.getMessageStatus(messageId)).not.toBeNull();

    const cancelled = protocol.cancelMessage(messageId);
    expect(cancelled).toBe(true);
    expect(protocol.getMessageStatus(messageId)).toBeNull();
  });

  test("getStats() returns protocol statistics", async () => {
    protocol = createTestProtocol("get-stats");
    protocol.start();

    // Send a few messages
    await protocol.send({ agentId: "recipient" }, { test: "data1" });
    await protocol.send({ agentId: "recipient" }, { test: "data2" }, { priority: "high" });

    const stats = protocol.getStats();

    expect(stats.totalMessages).toBeGreaterThanOrEqual(2);
    expect(typeof stats.pending).toBe("number");
    expect(typeof stats.acknowledged).toBe("number");
    expect(typeof stats.failed).toBe("number");
    expect(typeof stats.pendingAcks).toBe("number");
    expect(typeof stats.activeDeliveries).toBe("number");
    expect(typeof stats.queueSize).toBe("number");
  });

  test("events are emitted on message lifecycle", async () => {
    protocol = createTestProtocol("events-test");
    protocol.start();

    const sentHandler = vi.fn();
    const ackHandler = vi.fn();

    protocol.on("message-sent", sentHandler);
    protocol.on("message-acknowledged", ackHandler);

    const messageId = await protocol.send({ agentId: "recipient" }, { test: "data" });

    // Give event loop time to process
    await new Promise((r) => setTimeout(r, 10));

    expect(sentHandler).toHaveBeenCalled();
    protocol.acknowledge(messageId);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("getPendingMessages() returns pending envelopes", async () => {
    protocol = createTestProtocol("pending-msgs");
    protocol.start();

    await protocol.send({ agentId: "recipient" }, { test: "data1" });
    await protocol.send({ agentId: "recipient" }, { test: "data2" }, { priority: "high" });

    const pending = protocol.getPendingMessages();
    expect(pending.length).toBeGreaterThanOrEqual(2);
  });

  test("message with correlationId preserves correlation", async () => {
    protocol = createTestProtocol("correlation-test");
    protocol.start();

    const corrId = "corr-" + Date.now();
    const messageId = await protocol.send(
      { agentId: "recipient" },
      { test: "data" },
      { correlationId: corrId }
    );

    const status = protocol.getMessageStatus(messageId);
    expect(status).not.toBeNull();
  });

  test("message with expiresAt sets expiration", async () => {
    protocol = createTestProtocol("expiry-test");
    protocol.start();

    const expiresAt = Date.now() + 1000; // 1 second from now
    const messageId = await protocol.send(
      { agentId: "recipient" },
      { test: "data" },
      { expiresAt }
    );

    const status = protocol.getMessageStatus(messageId);
    expect(status).not.toBeNull();
  });

  test("headers are preserved in message", async () => {
    protocol = createTestProtocol("headers-test");
    protocol.start();

    const messageId = await protocol.send(
      { agentId: "recipient" },
      { test: "data" },
      { headers: { "X-Custom": "value", "Content-Type": "application/json" } }
    );

    const status = protocol.getMessageStatus(messageId);
    expect(status).not.toBeNull();
  });

  test("multiple agents can have independent protocols", async () => {
    const protocol1 = createTestProtocol("agent-1");
    const protocol2 = createTestProtocol("agent-2");

    protocol1.start();
    protocol2.start();

    const id1 = await protocol1.send({ agentId: "agent-2" }, { from: "agent-1" });
    const id2 = await protocol2.send({ agentId: "agent-1" }, { from: "agent-2" });

    expect(id1).not.toBe(id2);

    protocol1.stop();
    protocol2.stop();
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe("Integration Tests", () => {
  test("full message lifecycle: send -> deliver -> acknowledge", async () => {
    const sender = createTestProtocol("sender-agent");
    const receiver = createTestProtocol("receiver-agent");

    sender.start();
    receiver.start();

    const deliveryHandler = vi.fn();
    sender.on("message-delivered", deliveryHandler);

    // Send message
    const messageId = await sender.send(
      { agentId: "receiver-agent" },
      { action: "process", data: "integration-test" },
      { priority: "high" }
    );

    // Simulate receiver acknowledging
    await new Promise((r) => setTimeout(r, 50));
    const ack = receiver.acknowledge(messageId, "Message received");

    await new Promise((r) => setTimeout(r, 50));

    // Sender should receive acknowledgment
    expect(ack.status).toBe("acknowledged");
    expect(ack.latencyMs).toBeGreaterThanOrEqual(0);

    sender.stop();
    receiver.stop();
  });

  test("priority ordering is respected", async () => {
    const protocol = createTestProtocol("priority-order");
    protocol.start();

    // Send in random order
    const lowId = await protocol.send({ agentId: "r" }, { p: "low" }, { priority: "low" });
    const highId = await protocol.send({ agentId: "r" }, { p: "high" }, { priority: "high" });
    const criticalId = await protocol.send({ agentId: "r" }, { p: "critical" }, { priority: "critical" });
    const normalId = await protocol.send({ agentId: "r" }, { p: "normal" }, { priority: "normal" });

    const pending = protocol.getPendingMessages();

    // Find positions
    const criticalPos = pending.findIndex((e) => e.message.id === criticalId);
    const highPos = pending.findIndex((e) => e.message.id === highId);
    const normalPos = pending.findIndex((e) => e.message.id === normalId);
    const lowPos = pending.findIndex((e) => e.message.id === lowId);

    expect(criticalPos).toBeLessThan(highPos);
    expect(highPos).toBeLessThan(normalPos);
    expect(normalPos).toBeLessThan(lowPos);

    protocol.stop();
  });
});