const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");
const { createHost, definePlugin } = require("@regenic/plugin-host");
const {
  MemoryConnectorRegistry,
  MemoryEgressRegistry,
  verifyChannelDriverConformance,
} = require("@regenic/connector-test-utils");
const { ChannelDriverError } = require("@regenic/connector-contract");
const {
  WeComApiError,
  WeComChatEgress,
  resetWeComClientsForTests,
  setWeComClientForTests,
  wecomChatDriver,
  wecomChatPlugin,
} = require("../dist/index.js");

describe("wecomChatPlugin", () => {
  it("registers one stream and one egress adapter per conversation", async () => {
    const host = await createHost();
    const connectors = new MemoryConnectorRegistry();
    const egress = new MemoryEgressRegistry();
    await host.plugin(definePlugin({
      name: "registries",
      apply(ctx) {
        ctx.provide("connectors", connectors);
        ctx.provide("egress", egress);
      },
    }));
    const mounted = await host.plugin(wecomChatPlugin, {
      installation_id: "wecom-1",
      org_id: "local-owner",
      client: fakeClient(),
      conversations: [
        { conversation_id: "wr-1", name: "工程群", chat_mode: "group" },
        { conversation_id: "user-2", name: "小微", chat_mode: "p2p", peer_user_id: "user-2" },
      ],
    });
    assert.deepEqual(
      connectors.listStreams("wecom-1").map((stream) => stream.thread_id),
      ["wecom:wr-1", "wecom:user-2"],
    );
    assert.equal(egress.get("wecom-1", "chat:user-2")?.source, "wecom");
    await mounted.dispose();
    assert.equal(connectors.listStreams("wecom-1").length, 0);
    assert.equal(egress.get("wecom-1", "chat:user-2"), undefined);
    await host.dispose();
  });
});

describe("WeComChatEgress", () => {
  it("sends text and refuses an attachment", async () => {
    const calls = [];
    const egress = new WeComChatEgress(fakeClient(calls), {
      installation_id: "wecom-1",
      conversation_id: "wr-1",
      chat_mode: "group",
    });
    const receipt = await egress.send({
      installation_id: "wecom-1",
      content: [{ role: "body", media_type: "text/plain", text: "收到" }],
    });
    assert.equal(receipt.rpc_id, "req-1");
    assert.deepEqual(calls, [{ conversation_id: "wr-1", chat_mode: "group", text: "收到" }]);
    await assert.rejects(
      () => egress.send({
        installation_id: "wecom-1",
        content: [{
          role: "attachment",
          media_type: "image/png",
          bytes: new Uint8Array([1]),
        }],
      }),
      (error) => error instanceof WeComApiError,
    );
  });
});

describe("wecomChatDriver", () => {
  afterEach(() => {
    resetWeComClientsForTests();
  });

  it("keeps the bot secret out of stored config", () => {
    const installed = wecomChatDriver.install({
      id: "wecom-1",
      org_id: "local-owner",
      config: {
        bot_id: "bot-1",
        bot_secret: "secret-value",
        selection: "recent",
        kinds: ["group"],
      },
      now: "2026-10-14T00:00:00.000Z",
    });
    assert.equal(installed.config.bot_secret, undefined);
    assert.equal(installed.config.bot_id, "bot-1");
    assert.equal(installed.config.selection, "recent");
    assert.equal(installed.credentials_ref, "keychain:wecom-chat");
    assert.equal(JSON.stringify(installed).includes("secret-value"), false);
    verifyChannelDriverConformance({
      driver: wecomChatDriver,
      enabled: installed,
      disabled: { ...installed, status: "disabled" },
    });
    assert.deepEqual(wecomChatDriver.capabilities(installed), {
      sync: true,
      reply: true,
      create: false,
      list_title: "conversation",
      hydrate_on_open: true,
    });
  });

  it("requires a conversation id when the install picks conversations", () => {
    assert.throws(
      () => wecomChatDriver.install({
        id: "wecom-1",
        org_id: "local-owner",
        config: { bot_id: "bot-1", selection: "pick" },
        now: "2026-10-14T00:00:00.000Z",
      }),
      (error) => error instanceof ChannelDriverError && error.code === "invalid_config",
    );
  });

  it("mounts discovered conversations and sends through the mounted egress", async () => {
    setWeComClientForTests({
      async ensureConnected() {},
      describeConversation(conversationId) {
        return { conversation_id: conversationId, name: "工程群", chat_mode: "group" };
      },
      async listRecentConversations() {
        return [{ conversation_id: "wr-1", name: "工程群", chat_mode: "group" }];
      },
      async listMessages() {
        return [];
      },
      async sendText() {
        return { message_id: "req-1" };
      },
    });
    const { host, connectors, egress, facade } = await mountedHost();
    const installed = wecomChatDriver.install({
      id: "wecom-1",
      org_id: "local-owner",
      config: { bot_id: "bot-1", selection: "recent" },
      now: "2026-10-14T00:00:00.000Z",
    });
    const streams = await wecomChatDriver.resolveStreams(
      installed,
      facade,
      {},
      { discover: true },
    );
    assert.deepEqual(streams.map((stream) => stream.thread_id), ["wecom:wr-1"]);
    assert.equal(connectors.getStream("wecom-1", "chat:wr-1")?.label, "工程群");
    const adapter = await wecomChatDriver.bindEgress(
      installed,
      { source: "wecom", target: "wr-1", outbound: [] },
      facade,
      {},
    );
    assert.equal(adapter, egress.get("wecom-1", "chat:wr-1"));
    const receipt = await adapter.send({
      installation_id: "wecom-1",
      content: [{ role: "body", media_type: "text/plain", text: "收到" }],
    });
    assert.equal(
      wecomChatDriver.outboundId(
        { source: "wecom", target: "wr-1", outbound: [] },
        receipt,
      ),
      "wr-1:out:req-1",
    );
    assert.deepEqual(wecomChatDriver.writeBackLabels("同意"), [
      "同意",
      "通过",
      "批准",
      "Approve",
      "approve",
      "Yes",
      "yes",
    ]);
    const probe = await wecomChatDriver.probeCatalog({
      env: { WECOM_BOT_ID: "bot-1", WECOM_BOT_SECRET: "secret-value" },
    });
    assert.equal(probe.services["wecom-bot"].ready, true);
    assert.equal(JSON.stringify(probe).includes("secret-value"), false);
    await host.dispose();
  });
});

async function mountedHost() {
  const host = await createHost();
  const connectors = new MemoryConnectorRegistry();
  const egress = new MemoryEgressRegistry();
  await host.plugin(definePlugin({
    name: "registries",
    apply(ctx) {
      ctx.provide("connectors", connectors);
      ctx.provide("egress", egress);
    },
  }));
  return {
    host,
    connectors,
    egress,
    facade: {
      get: (name) => host.get(name),
      plugin: (plugin, config) => host.plugin(plugin, config),
      now: () => "2026-10-14T00:00:00.000Z",
      secrets: {
        async read(_type, _id, field) {
          return field === "bot_secret" ? "secret-value" : undefined;
        },
        write() {},
      },
    },
  };
}

function fakeClient(calls = []) {
  return {
    async ensureConnected() {},
    describeConversation() {
      return undefined;
    },
    async listRecentConversations() {
      return [];
    },
    async listMessages() {
      return [];
    },
    async sendText(input) {
      calls.push({
        conversation_id: input.conversation_id,
        chat_mode: input.chat_mode,
        text: input.text,
      });
      return { message_id: "req-1" };
    },
  };
}
