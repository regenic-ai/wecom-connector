import type { WeComChatMode, WeComConversation, WeComInboundMessage } from "./wecom-message";
import {
  acceptWeComFrame,
  describeWeComConversation,
  listWeComConversations,
  listWeComMessages,
} from "./wecom-inbox";
import {
  WeComGateway,
  type OpenWeComSocket,
  type WeComCredentials,
} from "./wecom-gateway";

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
  open?: OpenWeComSocket;
  now?: () => number;
  heartbeat_ms?: number;
  reconnect?: boolean;
}

export class WeComAppClient implements WeComImClient {
  private readonly gateway: WeComGateway;

  constructor(
    private readonly credentials: WeComCredentials,
    options: WeComAppClientOptions = {},
  ) {
    this.gateway = new WeComGateway(credentials, {
      open: options.open,
      heartbeat_ms: options.heartbeat_ms,
      reconnect: options.reconnect,
      onInbound: (frame) => {
        acceptWeComFrame(credentials.bot_id, frame, options.now?.());
      },
    });
  }

  matches(credentials: WeComCredentials): boolean {
    return this.credentials.bot_id === credentials.bot_id
      && this.credentials.secret === credentials.secret;
  }

  async ensureConnected(): Promise<void> {
    await this.gateway.ensureConnected();
  }

  disconnect(): void {
    this.gateway.disconnect();
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
    const described = this.describeConversation(input.conversation_id);
    const chatMode = input.chat_mode ?? described?.chat_mode;
    return this.gateway.sendMarkdown({
      chat_id: input.conversation_id,
      chat_type: chatTypeOf(chatMode),
      text: input.text,
    });
  }
}

function chatTypeOf(chatMode: WeComChatMode | undefined): 0 | 1 | 2 {
  if (chatMode === "p2p") {
    return 1;
  }
  if (chatMode === "group") {
    return 2;
  }
  return 0;
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
