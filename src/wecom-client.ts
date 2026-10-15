import {
  WSAuthFailureError,
  WSClient,
  WSReconnectExhaustedError,
  type Logger,
  type SendMarkdownMsgBody,
  type WsFrame,
} from "@wecom/aibot-node-sdk";
import type { WeComChatMode, WeComConversation, WeComInboundMessage } from "./wecom-message";
import {
  acceptWeComFrame,
  describeWeComConversation,
  listWeComConversations,
  listWeComMessages,
} from "./wecom-inbox";

const MAX_MARKDOWN_BYTES = 20_480;
const YIELDED_CONNECTION = "WeCom closed this connection because another client subscribed";

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

export interface WeComSendTextInput {
  conversation_id: string;
  chat_mode?: WeComChatMode;
  text: string;
}

export interface WeComImClient {
  ensureConnected(): Promise<void>;
  listRecentConversations(
    kinds?: readonly WeComChatMode[],
  ): Promise<WeComConversation[]>;
  describeConversation(conversationId: string): WeComConversation | undefined;
  listMessages(input: {
    conversation_id: string;
    after?: string;
    limit: number;
  }): Promise<WeComInboundMessage[]>;
  sendText(input: WeComSendTextInput): Promise<{ message_id: string }>;
}

export interface WeComAppClientOptions {
  now?: () => number;
  /** Overrides the SDK default `wss://openws.work.weixin.qq.com`. */
  wsUrl?: string;
  heartbeatInterval?: number;
  maxReconnectAttempts?: number;
  maxAuthFailureAttempts?: number;
}

export class WeComAppClient implements WeComImClient {
  private readonly sdk: WSClient;
  private readonly now: () => number;
  private authed = false;
  private yielded = false;
  private started = false;
  private connecting: Promise<void> | undefined;

  constructor(
    private readonly credentials: WeComCredentials,
    options: WeComAppClientOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sdk = new WSClient({
      botId: credentials.bot_id,
      secret: credentials.secret,
      logger: quietLogger(credentials.secret),
      ...(options.wsUrl ? { wsUrl: options.wsUrl } : {}),
      ...(options.heartbeatInterval !== undefined
        ? { heartbeatInterval: options.heartbeatInterval }
        : {}),
      ...(options.maxReconnectAttempts !== undefined
        ? { maxReconnectAttempts: options.maxReconnectAttempts }
        : {}),
      ...(options.maxAuthFailureAttempts !== undefined
        ? { maxAuthFailureAttempts: options.maxAuthFailureAttempts }
        : {}),
    });
    this.sdk.on("authenticated", () => {
      this.authed = true;
    });
    this.sdk.on("disconnected", (reason: string) => {
      this.authed = false;
      if (reason.includes("New connection established")) {
        this.yielded = true;
      }
    });
    this.sdk.on("message", (frame: WsFrame) => {
      acceptWeComFrame(this.credentials.bot_id, frame, this.now());
    });
  }

  matches(credentials: WeComCredentials): boolean {
    return this.credentials.bot_id === credentials.bot_id
      && this.credentials.secret === credentials.secret;
  }

  async ensureConnected(): Promise<void> {
    if (this.yielded) {
      throw new WeComApiError(YIELDED_CONNECTION);
    }
    if (this.authed) {
      return;
    }
    if (!this.connecting) {
      this.connecting = this.waitUntilAuthenticated().finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
  }

  disconnect(): void {
    this.authed = false;
    this.yielded = false;
    if (!this.started) {
      return;
    }
    this.started = false;
    this.sdk.disconnect();
  }

  async listRecentConversations(
    kinds?: readonly WeComChatMode[],
  ): Promise<WeComConversation[]> {
    await this.ensureConnected();
    return listWeComConversations(this.credentials.bot_id, kinds);
  }

  describeConversation(conversationId: string): WeComConversation | undefined {
    return describeWeComConversation(this.credentials.bot_id, conversationId);
  }

  async listMessages(input: {
    conversation_id: string;
    after?: string;
    limit: number;
  }): Promise<WeComInboundMessage[]> {
    await this.ensureConnected();
    return listWeComMessages(
      this.credentials.bot_id,
      input.conversation_id,
      input.after,
      input.limit,
    );
  }

  async sendText(input: WeComSendTextInput): Promise<{ message_id: string }> {
    if (Buffer.byteLength(input.text, "utf8") > MAX_MARKDOWN_BYTES) {
      throw new WeComApiError("WeCom markdown reply exceeds 20480 bytes");
    }
    await this.ensureConnected();
    const described = this.describeConversation(input.conversation_id);
    const chatMode = input.chat_mode ?? described?.chat_mode;
    const body: SendMarkdownMsgBody & { chat_type?: 1 | 2 } = {
      msgtype: "markdown",
      markdown: { content: input.text },
    };
    const chatType = chatTypeOf(chatMode);
    if (chatType) {
      body.chat_type = chatType;
    }
    try {
      const ack = await this.sdk.sendMessage(input.conversation_id, body);
      const messageId = ack.headers?.req_id?.trim();
      if (!messageId) {
        throw new WeComApiError("WeCom send did not return a request id");
      }
      return { message_id: messageId };
    } catch (error) {
      if (error instanceof WeComApiError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "WeCom send failed";
      throw new WeComApiError(scrub(message, this.credentials.secret));
    }
  }

  private waitUntilAuthenticated(): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        this.sdk.off("authenticated", onAuthenticated);
        this.sdk.off("error", onError);
        this.sdk.off("disconnected", onDisconnected);
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };
      const onAuthenticated = () => {
        finish();
      };
      const onError = (error: Error) => {
        if (
          error instanceof WSAuthFailureError
          || error instanceof WSReconnectExhaustedError
        ) {
          this.disconnect();
          finish(new WeComApiError(scrub(error.message, this.credentials.secret)));
        }
      };
      const onDisconnected = (reason: string) => {
        if (!reason.includes("New connection established")) {
          return;
        }
        this.yielded = true;
        finish(new WeComApiError(YIELDED_CONNECTION));
      };
      this.sdk.on("authenticated", onAuthenticated);
      this.sdk.on("error", onError);
      this.sdk.on("disconnected", onDisconnected);
      this.started = true;
      this.sdk.connect();
    });
  }
}

function chatTypeOf(chatMode: WeComChatMode | undefined): 1 | 2 | undefined {
  if (chatMode === "p2p") {
    return 1;
  }
  if (chatMode === "group") {
    return 2;
  }
  return undefined;
}

function quietLogger(secret: string): Logger {
  return {
    debug() {},
    info() {},
    warn(message: string, ...args: unknown[]) {
      console.warn(scrub([message, ...args.map(String)].join(" "), secret));
    },
    error(message: string, ...args: unknown[]) {
      console.error(scrub([message, ...args.map(String)].join(" "), secret));
    },
  };
}

function scrub(message: string, secret: string): string {
  if (!secret) {
    return message;
  }
  return message.split(secret).join("[secret]");
}

const liveClients = new Map<string, WeComAppClient>();
let clientOverride: WeComImClient | undefined;

export function setWeComClientForTests(client?: WeComImClient): void {
  clientOverride = client;
}

export function resetWeComClientsForTests(): void {
  for (const client of liveClients.values()) {
    client.disconnect();
  }
  liveClients.clear();
  clientOverride = undefined;
}

export function disconnectWeComClients(): void {
  for (const client of liveClients.values()) {
    client.disconnect();
  }
  liveClients.clear();
}

export function wecomClientFor(credentials: WeComCredentials): WeComImClient {
  if (clientOverride) {
    return clientOverride;
  }
  const existing = liveClients.get(credentials.bot_id);
  if (existing?.matches(credentials)) {
    return existing;
  }
  existing?.disconnect();
  const client = new WeComAppClient(credentials);
  liveClients.set(credentials.bot_id, client);
  return client;
}
