import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export const WECOM_WS_URL = "wss://openws.work.weixin.qq.com";
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_MARKDOWN_BYTES = 20_480;

export class WeComApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "WeComApiError";
  }
}

export interface WeComCredentials {
  bot_id: string;
  secret: string;
}

export interface WeComFrame {
  cmd?: string;
  headers?: { req_id?: string };
  body?: Record<string, unknown>;
  errcode?: number;
  errmsg?: string;
}

export interface WeComSocket {
  send(data: string): void;
  close(): void;
}

export interface WeComSocketOpen {
  socket: WeComSocket;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
}

export type OpenWeComSocket = (url: string) => Promise<WeComSocketOpen>;

export interface WeComGatewayOptions {
  open?: OpenWeComSocket;
  heartbeat_ms?: number;
  request_timeout_ms?: number;
  reconnect?: boolean;
  onInbound?: (frame: WeComFrame) => void;
  randomId?: () => string;
}

interface PendingRequest {
  resolve: (frame: WeComFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WeComGateway {
  private socket: WeComSocket | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connecting: Promise<void> | undefined;
  private subscribed = false;
  private running = false;
  private attempt = 0;
  private generation = 0;

  constructor(
    private readonly credentials: WeComCredentials,
    private readonly options: WeComGatewayOptions = {},
  ) {}

  async ensureConnected(): Promise<void> {
    this.running = true;
    if (this.subscribed && this.socket) {
      return;
    }
    if (!this.connecting) {
      const generation = this.generation;
      this.connecting = this.start(generation)
        .catch((error: unknown) => {
          this.armReconnect();
          throw error;
        })
        .finally(() => {
          this.connecting = undefined;
        });
    }
    await this.connecting;
  }

  disconnect(): void {
    this.running = false;
    this.generation += 1;
    this.clearReconnect();
    this.stopHeartbeat();
    this.rejectPending(new WeComApiError("WeCom connection closed"));
    const socket = this.socket;
    this.socket = undefined;
    this.subscribed = false;
    socket?.close();
  }

  async sendMarkdown(input: {
    chat_id: string;
    chat_type: 0 | 1 | 2;
    text: string;
  }): Promise<{ message_id: string }> {
    if (Buffer.byteLength(input.text, "utf8") > MAX_MARKDOWN_BYTES) {
      throw new WeComApiError("WeCom markdown reply exceeds 20480 bytes");
    }
    await this.ensureConnected();
    const reqId = this.nextId();
    const body: Record<string, unknown> = {
      chatid: input.chat_id,
      msgtype: "markdown",
      markdown: { content: input.text },
    };
    if (input.chat_type !== 0) {
      body.chat_type = input.chat_type;
    }
    await this.request(this.generation, {
      cmd: "aibot_send_msg",
      headers: { req_id: reqId },
      body,
    });
    return { message_id: reqId };
  }

  private async start(generation: number): Promise<void> {
    const open = this.options.open ?? openWeComWebSocket;
    let opened: WeComSocketOpen;
    try {
      opened = await open(WECOM_WS_URL);
    } catch {
      throw new WeComApiError("WeCom connection failed");
    }
    if (generation !== this.generation || !this.running) {
      opened.socket.close();
      throw new WeComApiError("WeCom connection closed");
    }
    this.socket = opened.socket;
    opened.onMessage((data) => {
      if (generation === this.generation) {
        this.handleRaw(data);
      }
    });
    opened.onClose(() => {
      if (generation !== this.generation) {
        return;
      }
      this.socket = undefined;
      this.subscribed = false;
      this.stopHeartbeat();
      this.rejectPending(new WeComApiError("WeCom connection closed"));
      this.armReconnect();
    });
    const reqId = this.nextId();
    try {
      await this.request(generation, {
        cmd: "aibot_subscribe",
        headers: { req_id: reqId },
        body: {
          bot_id: this.credentials.bot_id,
          secret: this.credentials.secret,
        },
      });
    } catch (error) {
      this.socket = undefined;
      this.subscribed = false;
      opened.socket.close();
      throw error;
    }
    if (generation !== this.generation) {
      throw new WeComApiError("WeCom connection closed");
    }
    this.subscribed = true;
    this.attempt = 0;
    this.startHeartbeat(generation);
  }

  private request(generation: number, frame: WeComFrame): Promise<WeComFrame> {
    const reqId = frame.headers?.req_id;
    const socket = this.socket;
    if (!reqId || !socket || generation !== this.generation) {
      return Promise.reject(new WeComApiError("WeCom connection closed"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new WeComApiError("WeCom request timed out"));
      }, this.options.request_timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(reqId, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify(frame));
      } catch {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(new WeComApiError("WeCom connection failed"));
      }
    });
  }

  private handleRaw(data: string): void {
    let frame: WeComFrame;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!isFrame(parsed)) {
        return;
      }
      frame = parsed;
    } catch {
      return;
    }
    if (frame.cmd === "aibot_msg_callback" || frame.cmd === "aibot_event_callback") {
      this.options.onInbound?.(frame);
      return;
    }
    const reqId = frame.headers?.req_id?.trim();
    if (!reqId) {
      return;
    }
    const pending = this.pending.get(reqId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(reqId);
    if (frame.errcode !== 0) {
      const detail = stringValue(frame.errmsg);
      const base = frame.errcode === undefined
        ? "WeCom response is invalid"
        : `WeCom request failed (${frame.errcode})`;
      pending.reject(new WeComApiError(
        scrub(detail ? `${base}: ${detail}` : base, this.credentials.secret),
        frame.errcode,
      ));
      return;
    }
    pending.resolve(frame);
  }

  private startHeartbeat(generation: number): void {
    this.stopHeartbeat();
    const interval = this.options.heartbeat_ms ?? DEFAULT_HEARTBEAT_MS;
    if (interval <= 0) {
      return;
    }
    this.heartbeat = setInterval(() => {
      if (generation !== this.generation || !this.subscribed) {
        return;
      }
      void this.request(generation, {
        cmd: "ping",
        headers: { req_id: this.nextId() },
      }).catch(() => {
        if (generation === this.generation) {
          this.socket?.close();
        }
      });
    }, interval);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private armReconnect(): void {
    if (!this.running || this.options.reconnect === false || this.reconnectTimer) {
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.running) {
        return;
      }
      void this.ensureConnected().catch(() => undefined);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private nextId(): string {
    return this.options.randomId?.() ?? randomUUID();
  }
}

export function openWeComWebSocket(url: string): Promise<WeComSocketOpen> {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    const fail = () => {
      socket.removeListener("open", ready);
      reject(new WeComApiError("WeCom connection failed"));
    };
    const ready = () => {
      socket.removeListener("error", fail);
      resolve({
        socket: {
          send(data: string) {
            socket.send(data);
          },
          close() {
            socket.close();
          },
        },
        onMessage(handler) {
          socket.on("message", (data) => {
            handler(socketDataToText(data));
          });
        },
        onClose(handler) {
          socket.on("close", () => {
            handler();
          });
        },
      });
    };
    socket.once("open", ready);
    socket.once("error", fail);
  });
}

function socketDataToText(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString();
  }
  if (Buffer.isBuffer(data)) {
    return data.toString();
  }
  return String(data);
}

function scrub(message: string, secret: string): string {
  if (!secret) {
    return message;
  }
  return message.split(secret).join("[secret]");
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isFrame(value: unknown): value is WeComFrame {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
