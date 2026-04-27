#!/usr/bin/env bun
/**
 * agent-communication-protocol - Inter-agent message passing protocol with delivery guarantees,
 * acknowledgment receipts, and priority queuing
 *
 * A robust message passing system for AI agent networks with:
 * - At-least-once delivery semantics
 * - Priority-based message queuing
 * - Acknowledgment receipts with timeouts
 * - Message persistence and retry logic
 * - Delivery confirmation callbacks
 *
 * @author Retsumdk
 * @version 1.0.0
 */

import { EventEmitter } from "events";
import { randomBytes, createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { setTimeout as delay } from "timers/promises";

// ============================================================================
// Types & Interfaces
// ============================================================================

export type MessagePriority = "critical" | "high" | "normal" | "low";
export type DeliveryStatus = "pending" | "queued" | "sent" | "acknowledged" | "failed" | "expired";

export interface AgentAddress {
  agentId: string;
  namespace?: string;
  endpoint?: string;
}

export interface Message {
  id: string;
  from: AgentAddress;
  to: AgentAddress;
  payload: unknown;
  priority: MessagePriority;
  timestamp: number;
  expiresAt?: number;
  correlationId?: string;
  replyTo?: string;
  headers: Record<string, string>;
}

export interface Acknowledgment {
  messageId: string;
  status: DeliveryStatus;
  receivedAt: number;
  latencyMs: number;
  signature?: string;
  details?: string;
}

export interface DeliveryReceipt {
  messageId: string;
  status: DeliveryStatus;
  attempts: number;
  lastAttempt: number;
  acknowledgedAt?: number;
  error?: string;
}

export interface MessageEnvelope {
  message: Message;
  receipt: DeliveryReceipt;
  acks: Acknowledgment[];
}

// ============================================================================
// Utilities
// ============================================================================

function generateMessageId(): string {
  return `${Date.now()}-${randomBytes(8).toString("hex")}`;
}

function hashMessage(msg: Message): string {
  const content = JSON.stringify({ id: msg.id, payload: msg.payload, timestamp: msg.timestamp });
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function priorityToNumber(priority: MessagePriority): number {
  const map: Record<MessagePriority, number> = {
    critical: 0,
    high: 1,
    normal: 2,
    low: 3,
  };
  return map[priority];
}

function currentTimestamp(): number {
  return Date.now();
}

// ============================================================================
// Priority Queue Implementation
// ============================================================================

class PriorityQueue<T> {
  private items: { priority: number; data: T; timestamp: number }[] = [];

  enqueue(item: T, priority: MessagePriority): void {
    const p = priorityToNumber(priority);
    const entry = { priority: p, data: item, timestamp: currentTimestamp() };
    // Insert in sorted order
    let i = 0;
    while (i < this.items.length && this.items[i].priority <= p) {
      i++;
    }
    this.items.splice(i, 0, entry);
  }

  dequeue(): T | undefined {
    return this.items.shift()?.data;
  }

  peek(): T | undefined {
    return this.items[0]?.data;
  }

  size(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  clear(): void {
    this.items = [];
  }

  filter(predicate: (item: T) => boolean): T[] {
    return this.items.filter((e) => predicate(e.data)).map((e) => e.data);
  }
}

// ============================================================================
// Message Store - Persistence Layer
// ============================================================================

class MessageStore {
  private storePath: string;
  private messages: Map<string, MessageEnvelope> = new Map();

  constructor(storePath?: string) {
    this.storePath = storePath || join(process.cwd(), ".acp-messages");
    this.ensureStoreDir();
    this.loadFromDisk();
  }

  private ensureStoreDir(): void {
    if (!existsSync(this.storePath)) {
      mkdirSync(this.storePath, { recursive: true });
    }
  }

  private loadFromDisk(): void {
    const indexPath = join(this.storePath, "index.json");
    if (existsSync(indexPath)) {
      try {
        const data = JSON.parse(readFileSync(indexPath, "utf-8"));
        for (const [id, envelope] of Object.entries(data)) {
          this.messages.set(id, envelope as MessageEnvelope);
        }
      } catch (e) {
        console.warn("Failed to load message store from disk:", e);
      }
    }
  }

  private saveToDisk(): void {
    const indexPath = join(this.storePath, "index.json");
    const data: Record<string, MessageEnvelope> = {};
    this.messages.forEach((v, k) => { data[k] = v; });
    try {
      writeFileSync(indexPath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn("Failed to save message store to disk:", e);
    }
  }

  put(envelope: MessageEnvelope): void {
    this.messages.set(envelope.message.id, envelope);
    this.saveToDisk();
  }

  get(messageId: string): MessageEnvelope | undefined {
    return this.messages.get(messageId);
  }

  update(messageId: string, updates: Partial<DeliveryReceipt>): boolean {
    const envelope = this.messages.get(messageId);
    if (!envelope) return false;
    envelope.receipt = { ...envelope.receipt, ...updates };
    this.messages.set(messageId, envelope);
    this.saveToDisk();
    return true;
  }

  addAck(messageId: string, ack: Acknowledgment): boolean {
    const envelope = this.messages.get(messageId);
    if (!envelope) return false;
    envelope.acks.push(ack);
    this.messages.set(messageId, envelope);
    this.saveToDisk();
    return true;
  }

  getAllPending(): MessageEnvelope[] {
    const result: MessageEnvelope[] = [];
    this.messages.forEach((env) => {
      if (["pending", "queued", "sent"].includes(env.receipt.status)) {
        result.push(env);
      }
    });
    return result.sort((a, b) => a.message.timestamp - b.message.timestamp);
  }

  remove(messageId: string): boolean {
    const result = this.messages.delete(messageId);
    if (result) this.saveToDisk();
    return result;
  }

  size(): number {
    return this.messages.size;
  }
}

// ============================================================================
// Acknowledgment Manager
// ============================================================================

class AcknowledgmentManager extends EventEmitter {
  private pendingAcks: Map<string, NodeJS.Timeout> = new Map();
  private ackCallbacks: Map<string, (ack: Acknowledgment) => void> = new Map();
  private defaultTimeout: number = 30000;

  setDefaultTimeout(ms: number): void {
    this.defaultTimeout = ms;
  }

  registerPending(messageId: string, onAck: (ack: Acknowledgment) => void, timeoutMs?: number): void {
    const timeout = timeoutMs || this.defaultTimeout;
    this.ackCallbacks.set(messageId, onAck);

    const timer = setTimeout(() => {
      this.handleAckTimeout(messageId);
    }, timeout);

    this.pendingAcks.set(messageId, timer);
    this.emit("pending", messageId);
  }

  receiveAck(ack: Acknowledgment): void {
    const { messageId } = ack;
    if (this.pendingAcks.has(messageId)) {
      clearTimeout(this.pendingAcks.get(messageId)!);
      this.pendingAcks.delete(messageId);
    }

    const callback = this.ackCallbacks.get(messageId);
    if (callback) {
      callback(ack);
      this.ackCallbacks.delete(messageId);
    }

    this.emit("acked", ack);
  }

  private handleAckTimeout(messageId: string): void {
    const ack: Acknowledgment = {
      messageId,
      status: "expired",
      receivedAt: currentTimestamp(),
      latencyMs: -1,
      details: "Acknowledgment timeout exceeded",
    };

    const callback = this.ackCallbacks.get(messageId);
    if (callback) {
      callback(ack);
      this.ackCallbacks.delete(messageId);
    }

    this.pendingAcks.delete(messageId);
    this.emit("timeout", messageId);
  }

  cancelPending(messageId: string): void {
    if (this.pendingAcks.has(messageId)) {
      clearTimeout(this.pendingAcks.get(messageId)!);
      this.pendingAcks.delete(messageId);
    }
    this.ackCallbacks.delete(messageId);
  }

  getPendingCount(): number {
    return this.pendingAcks.size;
  }
}

// ============================================================================
// Delivery Agent - Core Message Delivery Engine
// ============================================================================

interface DeliveryOptions {
  retries: number;
  retryDelayMs: number;
  timeoutMs: number;
  onDelivery?: (receipt: DeliveryReceipt) => void;
}

const DEFAULT_DELIVERY_OPTIONS: DeliveryOptions = {
  retries: 3,
  retryDelayMs: 1000,
  timeoutMs: 30000,
};

class DeliveryAgent extends EventEmitter {
  private store: MessageStore;
  private ackManager: AcknowledgmentManager;
  private deliveryQueue: PriorityQueue<string>;
  private activeDeliveries: Set<string> = new Set();
  private maxConcurrent: number = 10;
  private options: DeliveryOptions;

  constructor(store: MessageStore, ackManager: AcknowledgmentManager, options: Partial<DeliveryOptions> = {}) {
    super();
    this.store = store;
    this.ackManager = ackManager;
    this.options = { ...DEFAULT_DELIVERY_OPTIONS, ...options };
    this.deliveryQueue = new PriorityQueue();
  }

  setMaxConcurrent(max: number): void {
    this.maxConcurrent = max;
  }

  enqueue(messageId: string, priority: MessagePriority): void {
    this.deliveryQueue.enqueue(messageId, priority);
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.activeDeliveries.size >= this.maxConcurrent) return;

    while (!this.deliveryQueue.isEmpty() && this.activeDeliveries.size < this.maxConcurrent) {
      const messageId = this.deliveryQueue.dequeue();
      if (messageId) {
        await this.deliverMessage(messageId);
      }
    }
  }

  private async deliverMessage(messageId: string): Promise<void> {
    const envelope = this.store.get(messageId);
    if (!envelope) {
      this.emit("error", new Error(`Message ${messageId} not found in store`));
      return;
    }

    this.activeDeliveries.add(messageId);
    this.store.update(messageId, { status: "sent", attempts: envelope.receipt.attempts + 1, lastAttempt: currentTimestamp() });

    let success = false;
    let lastError: string = "";

    for (let attempt = envelope.receipt.attempts + 1; attempt <= this.options.retries; attempt++) {
      try {
        // Simulate network delivery - in real implementation this would call the actual transport
        await this.sendToRecipient(envelope.message);

        this.store.update(messageId, { status: "acknowledged", acknowledgedAt: currentTimestamp() });
        success = true;

        const receipt: DeliveryReceipt = {
          messageId,
          status: "acknowledged",
          attempts: attempt,
          lastAttempt: currentTimestamp(),
          acknowledgedAt: currentTimestamp(),
        };

        if (this.options.onDelivery) {
          this.options.onDelivery(receipt);
        }

        this.emit("delivered", messageId, receipt);
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        this.emit("retry", messageId, attempt, lastError);
        if (attempt < this.options.retries) {
          await delay(this.options.retryDelayMs * attempt);
        }
      }
    }

    this.activeDeliveries.delete(messageId);

    if (!success) {
      this.store.update(messageId, { status: "failed", error: lastError });
      const receipt: DeliveryReceipt = {
        messageId,
        status: "failed",
        attempts: this.options.retries,
        lastAttempt: currentTimestamp(),
        error: lastError,
      };

      if (this.options.onDelivery) {
        this.options.onDelivery(receipt);
      }

      this.emit("failed", messageId, lastError);
    }

    // Process next in queue
    this.processQueue();
  }

  private async sendToRecipient(message: Message): Promise<void> {
    // In a real implementation, this would use HTTP, WebSocket, or another transport
    // For now, we simulate delivery with a small delay
    await delay(10);

    // Simulate occasional failures for testing (1% failure rate)
    if (Math.random() < 0.01) {
      throw new Error("Simulated delivery failure");
    }
  }

  getActiveCount(): number {
    return this.activeDeliveries.size;
  }

  getQueueSize(): number {
    return this.deliveryQueue.size();
  }
}

// ============================================================================
// Communication Protocol - Main API
// ============================================================================

export interface ProtocolConfig {
  storePath?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  ackTimeoutMs?: number;
  maxConcurrentDeliveries?: number;
}

export class AgentCommunicationProtocol extends EventEmitter {
  private store: MessageStore;
  private ackManager: AcknowledgmentManager;
  private deliveryAgent: DeliveryAgent;
  private localAgentId: string;
  private started: boolean = false;

  constructor(localAgentId: string, config: ProtocolConfig = {}) {
    super();
    this.localAgentId = localAgentId;
    this.store = new MessageStore(config.storePath);
    this.ackManager = new AcknowledgmentManager();

    const deliveryOptions: DeliveryOptions = {
      retries: config.maxRetries || 3,
      retryDelayMs: config.retryDelayMs || 1000,
      timeoutMs: config.ackTimeoutMs || 30000,
    };

    this.deliveryAgent = new DeliveryAgent(this.store, this.ackManager, deliveryOptions);
    if (config.maxConcurrentDeliveries) {
      this.deliveryAgent.setMaxConcurrent(config.maxConcurrentDeliveries);
    }

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.ackManager.on("acked", (ack: Acknowledgment) => {
      this.store.addAck(ack.messageId, ack);
      this.emit("message-acknowledged", ack);
    });

    this.ackManager.on("timeout", (messageId: string) => {
      this.store.update(messageId, { status: "expired" });
      this.emit("message-expired", messageId);
    });

    this.deliveryAgent.on("delivered", (messageId: string, receipt: DeliveryReceipt) => {
      this.emit("message-delivered", messageId, receipt);
    });

    this.deliveryAgent.on("failed", (messageId: string, error: string) => {
      this.emit("message-delivery-failed", messageId, error);
    });
  }

  start(): void {
    this.started = true;
    this.emit("started", this.localAgentId);
  }

  stop(): void {
    this.started = false;
    this.emit("stopped", this.localAgentId);
  }

  isStarted(): boolean {
    return this.started;
  }

  async send(to: AgentAddress, payload: unknown, options: {
    priority?: MessagePriority;
    expiresAt?: number;
    correlationId?: string;
    headers?: Record<string, string>;
    onAcknowledged?: (ack: Acknowledgment) => void;
  } = {}): Promise<string> {
    if (!this.started) {
      throw new Error("Protocol not started. Call start() first.");
    }

    const messageId = generateMessageId();
    const headers = options.headers || {};

    const message: Message = {
      id: messageId,
      from: { agentId: this.localAgentId },
      to,
      payload,
      priority: options.priority || "normal",
      timestamp: currentTimestamp(),
      expiresAt: options.expiresAt,
      correlationId: options.correlationId,
      headers,
    };

    const envelope: MessageEnvelope = {
      message,
      receipt: {
        messageId,
        status: "pending",
        attempts: 0,
        lastAttempt: 0,
      },
      acks: [],
    };

    this.store.put(envelope);
    this.store.update(messageId, { status: "queued" });

    if (options.onAcknowledged) {
      this.ackManager.registerPending(messageId, options.onAcknowledged);
    }

    this.deliveryAgent.enqueue(messageId, message.priority);
    this.emit("message-sent", messageId, message);

    return messageId;
  }

  async sendBatch(messages: Array<{
    to: AgentAddress;
    payload: unknown;
    priority?: MessagePriority;
    expiresAt?: number;
  }>): Promise<string[]> {
    const results: string[] = [];
    for (const msg of messages) {
      const id = await this.send(msg.to, msg.payload, {
        priority: msg.priority,
        expiresAt: msg.expiresAt,
      });
      results.push(id);
    }
    return results;
  }

  acknowledge(messageId: string, details?: string): Acknowledgment {
    const envelope = this.store.get(messageId);
    if (!envelope) {
      throw new Error(`Message ${messageId} not found`);
    }

    const ack: Acknowledgment = {
      messageId,
      status: "acknowledged",
      receivedAt: currentTimestamp(),
      latencyMs: currentTimestamp() - envelope.message.timestamp,
      signature: hashMessage(envelope.message),
      details,
    };

    this.ackManager.receiveAck(ack);
    return ack;
  }

  getMessageStatus(messageId: string): DeliveryReceipt | null {
    const envelope = this.store.get(messageId);
    return envelope ? envelope.receipt : null;
  }

  getPendingMessages(): MessageEnvelope[] {
    return this.store.getAllPending();
  }

  getMessageHistory(limit: number = 100): MessageEnvelope[] {
    const all = this.store.getAllPending();
    return all.slice(0, limit);
  }

  retryMessage(messageId: string, priority?: MessagePriority): boolean {
    const envelope = this.store.get(messageId);
    if (!envelope) return false;

    this.store.update(messageId, { status: "queued", attempts: 0, error: undefined });
    this.deliveryAgent.enqueue(messageId, priority || envelope.message.priority);
    return true;
  }

  cancelMessage(messageId: string): boolean {
    this.ackManager.cancelPending(messageId);
    return this.store.remove(messageId);
  }

  getStats(): {
    totalMessages: number;
    pending: number;
    acknowledged: number;
    failed: number;
    pendingAcks: number;
    activeDeliveries: number;
    queueSize: number;
  } {
    const pending = this.store.getAllPending();
    const acknowledged = this.store.size() - pending.filter((p) => ["pending", "queued", "sent", "failed"].includes(p.receipt.status)).length;

    return {
      totalMessages: this.store.size(),
      pending: pending.filter((p) => ["pending", "queued", "sent"].includes(p.receipt.status)).length,
      acknowledged,
      failed: pending.filter((p) => p.receipt.status === "failed").length,
      pendingAcks: this.ackManager.getPendingCount(),
      activeDeliveries: this.deliveryAgent.getActiveCount(),
      queueSize: this.deliveryAgent.getQueueSize(),
    };
  }
}

// ============================================================================
// CLI Interface
// ============================================================================

import { Command } from "commander";

const program = new Command();

program
  .name("agent-communication-protocol")
  .description("Inter-agent message passing protocol with delivery guarantees")
  .version("1.0.0");

program
  .command("send")
  .description("Send a message to an agent")
  .requiredOption("-t, --to <agentId>", "Destination agent ID")
  .requiredOption("-p, --payload <json>", "Message payload as JSON")
  .option("--priority <level>", "Message priority (critical|high|normal|low)", "normal")
  .option("--ttl <ms>", "Time to live in milliseconds")
  .option("-c, --config <path>", "Config file path", ".acp-config.json")
  .action(async (opts) => {
    const config = loadConfigFromFile(opts.config);
    const protocol = new AgentCommunicationProtocol(config.agentId || "cli-sender", {
      storePath: config.storePath,
    });
    protocol.start();

    protocol.on("message-acknowledged", (ack) => {
      console.log(`[ACK] Message ${ack.messageId} acknowledged in ${ack.latencyMs}ms`);
    });

    try {
      const payload = JSON.parse(opts.payload);
      const messageId = await protocol.send(
        { agentId: opts.to },
        payload,
        {
          priority: opts.priority as MessagePriority,
          expiresAt: opts.ttl ? currentTimestamp() + parseInt(opts.ttl) : undefined,
        }
      );
      console.log(`Message sent with ID: ${messageId}`);
    } catch (e) {
      console.error("Failed to send message:", e);
      process.exit(1);
    }
  });

program
  .command("ack")
  .description("Acknowledge receipt of a message")
  .requiredOption("-i, --id <messageId>", "Message ID to acknowledge")
  .option("-d, --details <text>", "Acknowledgment details")
  .option("-c, --config <path>", "Config file path", ".acp-config.json")
  .action(async (opts) => {
    const config = loadConfigFromFile(opts.config);
    const protocol = new AgentCommunicationProtocol(config.agentId || "cli-receiver", {
      storePath: config.storePath,
    });
    protocol.start();

    try {
      const ack = protocol.acknowledge(opts.id, opts.details);
      console.log(`Acknowledged: ${JSON.stringify(ack, null, 2)}`);
    } catch (e) {
      console.error("Failed to acknowledge:", e);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Check message delivery status")
  .requiredOption("-i, --id <messageId>", "Message ID to check")
  .option("-c, --config <path>", "Config file path", ".acp-config.json")
  .action((opts) => {
    const config = loadConfigFromFile(opts.config);
    const protocol = new AgentCommunicationProtocol(config.agentId || "cli-checker", {
      storePath: config.storePath,
    });

    const receipt = protocol.getMessageStatus(opts.id);
    if (receipt) {
      console.log(`Status for ${opts.id}: ${receipt.status}`);
      console.log(`Attempts: ${receipt.attempts}`);
      if (receipt.error) console.log(`Error: ${receipt.error}`);
    } else {
      console.log(`Message ${opts.id} not found`);
    }
  });

program
  .command("stats")
  .description("Show protocol statistics")
  .option("-c, --config <path>", "Config file path", ".acp-config.json")
  .action((opts) => {
    const config = loadConfigFromFile(opts.config);
    const protocol = new AgentCommunicationProtocol(config.agentId || "cli-stats", {
      storePath: config.storePath,
    });
    protocol.start();

    const stats = protocol.getStats();
    console.log("Protocol Statistics:");
    console.log(`  Total Messages: ${stats.totalMessages}`);
    console.log(`  Pending: ${stats.pending}`);
    console.log(`  Acknowledged: ${stats.acknowledged}`);
    console.log(`  Failed: ${stats.failed}`);
    console.log(`  Pending Acks: ${stats.pendingAcks}`);
    console.log(`  Active Deliveries: ${stats.activeDeliveries}`);
    console.log(`  Queue Size: ${stats.queueSize}`);
  });

function loadConfigFromFile(path: string): Record<string, unknown> {
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return {};
    }
  }
  return {};
}

// ============================================================================
// Main entry point
// ============================================================================

if (require.main === module) {
  program.parse(process.argv);
}

export default AgentCommunicationProtocol;