import {
  CONNECTOR_PROTOCOL,
  ChannelDriverError,
  keychainCredentialsRef,
  requireConnectorStream,
  type ChannelDriver,
  type ConnectorHost,
  type ConnectorInstallation,
  type ConnectorStream,
  type ConversationThread,
  type DeliveryReceipt,
  type NewConnectorInstallation,
  type ResolveStreamsOptions,
} from "@regenic/connector-contract";
import {
  wecomClientFor,
  disconnectWeComClients,
  type WeComImClient,
} from "./wecom-client";
import {
  configString,
  pickedConversationNames,
  wecomAllLabel,
  wecomInstallConfig,
  wecomKinds,
  wecomPickedConversationIds,
  wecomRecentLabel,
  wecomSelection,
  wecomStreamDiscover,
  wecomWriteBackLabels,
} from "./wecom-config";
import {
  resolveWeComConversationTargets,
  wecomConversationsFromCatalog,
  wecomConversationsFromThreads,
} from "./wecom-directory";
import { clearAllWeComInboxes } from "./wecom-inbox";
import { wecomLocaleTables } from "./locales";
import { WECOM_SOURCE } from "./wecom-message";
import type { WeComConversation } from "./wecom-message";
import { WeComChatPollConnector } from "./wecom-chat-poll-connector";
import { wecomChatPlugin } from "./plugin";
import { probeWeComCatalog } from "./probe";
import {
  createWeComPickedSyncSource,
  createWeComRecentSyncSource,
  createWeComSyncSource,
} from "./wecom-sync-source";
import {
  wecomConversationIdFromStreamKey,
  wecomStreamKey,
} from "./wecom-streams";
import type { WeComCredentials } from "./wecom-gateway";

export {
  wecomSelection,
  wecomStreamDiscover,
  wecomWriteBackLabels,
} from "./wecom-config";
export { setWeComClientForTests } from "./wecom-client";
export { WECOM_STREAM_PACE, wecomStreamKey } from "./wecom-streams";

const CONNECTOR_TYPE = "wecom-chat";

export const wecomChatDriver: ChannelDriver = {
  connector_type: CONNECTOR_TYPE,
  source: WECOM_SOURCE,
  connector_protocol: CONNECTOR_PROTOCOL,

  onStoreClear() {
    credentialCache.clear();
    clearAllWeComInboxes();
    disconnectWeComClients();
  },

  install(input): NewConnectorInstallation {
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: CONNECTOR_TYPE,
      status: "enabled",
      config: wecomInstallConfig(input.config),
      credentials_ref: keychainCredentialsRef(CONNECTOR_TYPE),
      created_at: input.now,
    };
  },

  matchesThread(installation, thread) {
    if (thread.source !== WECOM_SOURCE || installation.status !== "enabled") {
      return false;
    }
    if (wecomSelection(installation.config) !== "pick") {
      return true;
    }
    return wecomPickedConversationIds(installation.config).includes(thread.target);
  },

  ownsThread(installation, thread) {
    if (!this.matchesThread(installation, thread)) {
      return false;
    }
    return wecomSelection(installation.config) === "pick";
  },

  capabilities(installation) {
    if (installation.status !== "enabled") {
      return { sync: false, reply: false, create: false };
    }
    return {
      sync: true,
      reply: true,
      create: false,
      list_title: "conversation",
      hydrate_on_open: true,
    };
  },

  locales() {
    return wecomLocaleTables;
  },

  writeBackLabels(label) {
    return wecomWriteBackLabels(label);
  },

  installCatalog() {
    return {
      title: "catalog.title",
      channel_label: "catalog.channelLabel",
      description: "catalog.description",
      credential_hint: "catalog.credentialHint",
      fields: [
        {
          key: "bot_id",
          label: "field.botId",
          required: true,
          placeholder: "field.botId.placeholder",
        },
        {
          key: "bot_secret",
          label: "field.botSecret",
          required: true,
          secret: true,
          placeholder: "field.botSecret.placeholder",
        },
        {
          key: "sync_mode",
          label: "field.syncMode",
          required: true,
          default: "conversation",
          options: [
            { value: "conversation", label: "option.syncMode.conversation" },
            { value: "balanced", label: "option.syncMode.balanced" },
            { value: "context", label: "option.syncMode.context" },
          ],
        },
        {
          key: "selection",
          label: "field.selection",
          required: true,
          default: "recent",
          options: [
            { value: "recent", label: "option.selection.recent" },
            { value: "pick", label: "option.selection.pick" },
            { value: "all", label: "option.selection.all" },
          ],
        },
        {
          key: "kinds",
          label: "field.kinds",
          required: true,
          multiple: true,
          default: "group,p2p",
          options: [
            { value: "group", label: "option.kinds.group" },
            { value: "p2p", label: "option.kinds.p2p" },
          ],
          visible_when: { field: "selection", values: ["all", "recent"] },
        },
        {
          key: "conversation_ids",
          label: "field.conversationIds",
          required: true,
          placeholder: "field.conversationIds.placeholder",
          visible_when: { field: "selection", value: "pick" },
        },
      ],
      prerequisites: [
        {
          kind: "env" as const,
          key: "WECOM_BOT_ID",
          label: "prereq.botId",
          required: false,
          hint: "prereq.env.hint",
        },
        {
          kind: "env" as const,
          key: "WECOM_BOT_SECRET",
          label: "prereq.botSecret",
          required: false,
          hint: "prereq.env.hint",
        },
      ],
      setup_steps: [
        {
          title: "setup.createBot.title",
          body: "setup.createBot.body",
          href: "https://developer.work.weixin.qq.com/document/path/101463",
        },
        {
          title: "setup.mention.title",
          body: "setup.mention.body",
        },
        {
          title: "setup.choose.title",
          body: "setup.choose.body",
        },
      ],
      install_confirm: {
        when: { field: "selection", value: "all" },
        warning: "confirm.all.warning",
        ack: "confirm.all.ack",
      },
    };
  },

  presentInstall(installation) {
    const config = installation.config;
    const selection = wecomSelection(config);
    const conversationIds = wecomPickedConversationIds(config);
    if (selection === "recent") {
      return { label: wecomRecentLabel(config), detail: { literal: "bot" } };
    }
    if (selection === "all") {
      return { label: wecomAllLabel(config), detail: { literal: "bot" } };
    }
    const names = pickedConversationNames(config, conversationIds);
    if (conversationIds.length > 1) {
      return {
        label: { key: "present.pickedCount", params: { count: conversationIds.length } },
        detail: { literal: "bot" },
      };
    }
    return {
      label: {
        literal: names[0] ?? conversationIds[0] ?? installation.id,
      },
      detail: { literal: "bot" },
    };
  },

  async resolveStreams(installation, host, env, options?: ResolveStreamsOptions) {
    const client = await clientFor(installation, host, env);
    const mounted = conversationsFromStreams(
      host.get("connectors").listStreams(installation.id),
    );
    const selection = wecomSelection(installation.config);
    const conversations = await resolveWeComConversationTargets(
      installation.config,
      client,
      {
        known: mergeKnown(
          wecomConversationsFromThreads(options?.threads ?? [], (thread) =>
            this.matchesThread(installation, thread),
          ),
          wecomConversationsFromCatalog(options?.catalog ?? []),
          mounted,
        ),
        discover: wecomStreamDiscover(selection, options?.discover === true),
      },
    );
    return mountConversations(host, installation, conversations, client);
  },

  async bindSyncSource(installation, host, env) {
    const selection = wecomSelection(installation.config);
    if (selection === "pick") {
      const ids = wecomPickedConversationIds(installation.config);
      const names = pickedConversationNames(installation.config, ids);
      return createWeComPickedSyncSource(
        ids.map((conversation_id, index) => ({
          conversation_id,
          name: names[index],
        })),
      );
    }
    const client = await clientFor(installation, host, env);
    const kinds = wecomKinds(installation.config);
    if (selection === "recent") {
      return createWeComRecentSyncSource(client, kinds);
    }
    return createWeComSyncSource(client, kinds);
  },

  async resolveThreadStream(installation, thread, host, env) {
    if (!this.matchesThread(installation, thread)) {
      throw new ChannelDriverError(
        "unsupported_channel",
        "WeCom installation does not include this conversation",
      );
    }
    const client = await clientFor(installation, host, env);
    const mounted = conversationsFromStreams(
      host.get("connectors").listStreams(installation.id),
    ).find((conversation) => conversation.conversation_id === thread.target);
    const described = client.describeConversation(thread.target);
    const streams = await mountConversations(
      host,
      installation,
      [
        {
          conversation_id: thread.target,
          name:
            conversationName(installation.config, thread.target) ??
            mounted?.name ??
            described?.name,
          chat_mode: mounted?.chat_mode ?? described?.chat_mode,
          peer_user_id: mounted?.peer_user_id ?? described?.peer_user_id,
        },
      ],
      client,
    );
    return (
      streams[0] ??
      requireConnectorStream(
        host.get("connectors"),
        installation.id,
        wecomStreamKey(thread.target),
      )
    );
  },

  async bindEgress(installation, thread, host, env) {
    await this.resolveThreadStream(installation, thread, host, env);
    const egress = host.get("egress").get(
      installation.id,
      wecomStreamKey(thread.target),
    );
    if (!egress) {
      throw new ChannelDriverError(
        "send_failed",
        "WeCom egress adapter failed to mount",
      );
    }
    return egress;
  },

  outboundId(thread: ConversationThread, receipt: DeliveryReceipt) {
    const sent = receipt.rpc_id?.trim();
    if (sent) {
      return `${thread.target}:out:${sent}`;
    }
    return `${thread.target}:out:local`;
  },

  async resolveConversationLabels(installation, threads, env) {
    const labels = new Map<string, string>();
    const wanted = threads.filter((thread) => thread.source === WECOM_SOURCE);
    const ids = wecomPickedConversationIds(installation.config);
    const names = pickedConversationNames(installation.config, ids);
    if (ids.length > 0 && names.length === ids.length) {
      for (let index = 0; index < ids.length; index += 1) {
        const name = names[index]?.replace(/\s+/g, " ").trim();
        if (name) {
          labels.set(`${WECOM_SOURCE}:${ids[index]}`, name);
        }
      }
    }
    const missing = wanted.filter(
      (thread) => !labels.has(`${WECOM_SOURCE}:${thread.target}`),
    );
    if (missing.length === 0) {
      return labels;
    }
    const client = clientFromCache(installation, env);
    if (!client) {
      return labels;
    }
    for (const thread of missing.slice(0, 24)) {
      const name = client.describeConversation(thread.target)?.name?.replace(/\s+/g, " ").trim();
      if (name) {
        labels.set(`${WECOM_SOURCE}:${thread.target}`, name);
      }
    }
    return labels;
  },

  async probeCatalog({ env }) {
    return probeWeComCatalog({ env });
  },
};

const credentialCache = new Map<string, WeComCredentials>();

async function clientFor(
  installation: ConnectorInstallation,
  host: ConnectorHost,
  env: NodeJS.ProcessEnv,
): Promise<WeComImClient> {
  const credentials = await credentialsFor(installation, host, env);
  credentialCache.set(installation.id, credentials);
  return wecomClientFor(credentials);
}

function clientFromCache(
  installation: ConnectorInstallation,
  env: NodeJS.ProcessEnv,
): WeComImClient | undefined {
  const cached = credentialCache.get(installation.id);
  const botId = configString(installation.config, "bot_id") || env.WECOM_BOT_ID?.trim();
  const secret = env.WECOM_BOT_SECRET?.trim();
  const credentials = cached ?? (botId && secret
    ? { bot_id: botId, secret }
    : undefined);
  return credentials ? wecomClientFor(credentials) : undefined;
}

async function credentialsFor(
  installation: ConnectorInstallation,
  host: ConnectorHost,
  env: NodeJS.ProcessEnv,
): Promise<WeComCredentials> {
  const botId = configString(installation.config, "bot_id") || env.WECOM_BOT_ID?.trim() || "";
  const secret =
    (await host.secrets.read(CONNECTOR_TYPE, installation.id, "bot_secret")) ||
    env.WECOM_BOT_SECRET?.trim() ||
    "";
  if (!botId || !secret) {
    throw new ChannelDriverError(
      "missing_credentials",
      "WeCom bot id and secret are required",
    );
  }
  return { bot_id: botId, secret };
}

async function mountConversations(
  host: ConnectorHost,
  installation: ConnectorInstallation,
  conversations: WeComConversation[],
  client: WeComImClient,
): Promise<ConnectorStream[]> {
  const registry = host.get("connectors");
  const existing = new Set(
    registry.listStreams(installation.id).map((stream) => stream.stream_key),
  );
  const wanted = new Set(
    conversations.map((conversation) => wecomStreamKey(conversation.conversation_id)),
  );
  for (const stream of registry.listStreams(installation.id)) {
    const conversation = conversations.find(
      (item) => wecomStreamKey(item.conversation_id) === stream.stream_key,
    );
    if (conversation && stream.connector instanceof WeComChatPollConnector) {
      stream.connector.rememberConversation(conversation);
    }
  }
  const missing = conversations.filter(
    (conversation) => !existing.has(wecomStreamKey(conversation.conversation_id)),
  );
  if (missing.length > 0) {
    await host.plugin(wecomChatPlugin, {
      installation_id: installation.id,
      org_id: installation.org_id,
      conversations: missing,
      client,
    });
  }
  return registry
    .listStreams(installation.id)
    .filter((stream) => wanted.has(stream.stream_key));
}

function conversationsFromStreams(streams: readonly ConnectorStream[]): WeComConversation[] {
  return streams.flatMap((stream) => {
    if (stream.connector instanceof WeComChatPollConnector) {
      return [stream.connector.describeConversation()];
    }
    const conversationId = wecomConversationIdFromStreamKey(stream.stream_key);
    if (!conversationId) {
      return [];
    }
    return [
      {
        conversation_id: conversationId,
        ...(stream.label && stream.label !== conversationId ? { name: stream.label } : {}),
      },
    ];
  });
}

function mergeKnown(...groups: WeComConversation[][]): WeComConversation[] {
  const byId = new Map<string, WeComConversation>();
  for (const conversation of groups.flat()) {
    const prev = byId.get(conversation.conversation_id);
    byId.set(conversation.conversation_id, {
      conversation_id: conversation.conversation_id,
      name: conversation.name ?? prev?.name,
      chat_mode: conversation.chat_mode ?? prev?.chat_mode,
      ...(conversation.peer_user_id || prev?.peer_user_id
        ? { peer_user_id: conversation.peer_user_id ?? prev?.peer_user_id }
        : {}),
    });
  }
  return [...byId.values()];
}

function conversationName(
  config: Record<string, unknown>,
  conversationId: string,
): string | undefined {
  const ids = wecomPickedConversationIds(config);
  const names = pickedConversationNames(config, ids);
  const index = ids.indexOf(conversationId);
  return index >= 0 ? names[index] : undefined;
}
