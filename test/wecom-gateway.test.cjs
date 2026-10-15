const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { WebSocketServer } = require("ws");
const {
  WeComApiError,
  WeComAppClient,
  clearWeComInboxForTests,
  setWeComInboxRootForTests,
} = require("../dist/index.js");

describe("WeCom official SDK", { concurrency: false }, () => {
  let root;

  afterEach(() => {
    clearWeComInboxForTests();
    setWeComInboxRootForTests(undefined);
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("subscribes, stores an inbound callback, and sends markdown", async () => {
    root = mkdtempSync(join(tmpdir(), "wecom-sdk-"));
    setWeComInboxRootForTests(root);
    const sent = [];
    const gateway = await listen((frame) => {
      sent.push(frame);
      return {
        headers: { req_id: frame.headers.req_id },
        errcode: 0,
        errmsg: "ok",
      };
    });
    const client = new WeComAppClient(
      { bot_id: "bot-1", secret: "secret-value" },
      {
        wsUrl: gateway.url,
        now: () => 80,
        heartbeatInterval: 60_000,
        maxReconnectAttempts: 0,
      },
    );
    try {
      await client.ensureConnected();
      const subscribe = sent.find((frame) => frame.cmd === "aibot_subscribe");
      assert.equal(subscribe.body.bot_id, "bot-1");
      assert.equal(subscribe.body.secret, "secret-value");
      assert.match(subscribe.headers.req_id, /^aibot_subscribe_/);

      gateway.push({
        cmd: "aibot_msg_callback",
        headers: { req_id: "inbound-1" },
        body: {
          msgid: "msg-1",
          aibotid: "bot-1",
          chatid: "wr-group",
          chattype: "group",
          from: { userid: "user-1" },
          msgtype: "text",
          text: { content: "在吗" },
          conversation_title: "工程群",
        },
      });

      const messages = await waitForMessages(client);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].text, "在吗");
      assert.equal(messages[0].create_at, 80);
      assert.deepEqual(await client.listRecentConversations(["group"]), [
        {
          conversation_id: "wr-group",
          name: "工程群",
          chat_mode: "group",
        },
      ]);

      const sentMessage = await client.sendText({
        conversation_id: "wr-group",
        chat_mode: "group",
        text: "收到",
      });
      const reply = sent.find((frame) => frame.cmd === "aibot_send_msg");
      assert.equal(sentMessage.message_id, reply.headers.req_id);
      assert.match(reply.headers.req_id, /^aibot_send_msg_/);
      assert.equal(reply.body.chatid, "wr-group");
      assert.equal(reply.body.chat_type, 2);
      assert.equal(reply.body.msgtype, "markdown");
      assert.deepEqual(reply.body.markdown, { content: "收到" });
    } finally {
      client.disconnect();
      await gateway.close();
    }
  });

  it("scrubs the secret from a rejected subscribe", async () => {
    const gateway = await listen((frame) => ({
      headers: { req_id: frame.headers?.req_id },
      errcode: frame.cmd === "aibot_subscribe" ? 400 : 0,
      errmsg: frame.cmd === "aibot_subscribe" ? "bad secret-value" : "ok",
    }));
    const client = new WeComAppClient(
      { bot_id: "bot-1", secret: "secret-value" },
      {
        wsUrl: gateway.url,
        heartbeatInterval: 60_000,
        maxAuthFailureAttempts: 0,
        maxReconnectAttempts: 0,
      },
    );
    try {
      await assert.rejects(
        () => client.ensureConnected(),
        (error) => {
          assert.equal(error instanceof WeComApiError, true);
          assert.equal(error.message.includes("secret-value"), false);
          return true;
        },
      );
    } finally {
      client.disconnect();
      await gateway.close();
    }
  });
});

async function waitForMessages(client) {
  const started = Date.now();
  let messages = [];
  while (Date.now() - started < 1000) {
    messages = await client.listMessages({
      conversation_id: "wr-group",
      limit: 10,
    });
    if (messages.length > 0) {
      return messages;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return messages;
}

function listen(respond) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let socket;
  server.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      const response = respond(frame);
      if (response) {
        ws.send(JSON.stringify(response));
      }
    });
  });
  return new Promise((resolve) => {
    server.on("listening", () => {
      const address = server.address();
      resolve({
        url: `ws://127.0.0.1:${address.port}`,
        push(frame) {
          socket.send(JSON.stringify(frame));
        },
        close() {
          return new Promise((done) => {
            server.close(() => done());
          });
        },
      });
    });
  });
}
