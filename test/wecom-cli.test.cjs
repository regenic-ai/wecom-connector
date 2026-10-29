const assert = require("node:assert/strict");
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const {
  clearWeComInboxForTests,
  rememberWeComMessage,
  setWeComInboxRootForTests,
} = require("../dist/wecom-inbox.js");
const { runCli } = require("../dist/cli.js");

describe("WeCom local CLI", { concurrency: false }, () => {
  let root;

  afterEach(() => {
    clearWeComInboxForTests();
    setWeComInboxRootForTests(undefined);
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("saves only the Bot ID and checks local state without connecting", async () => {
    root = mkdtempSync(join(tmpdir(), "wecom-cli-"));
    const configPath = join(root, "nested", "config.json");
    const output = [];
    const env = {
      REGENIC_WECOM_CONFIG: configPath,
      REGENIC_WECOM_INBOX_DIR: join(root, "inbox"),
      WECOM_BOT_SECRET: "must-not-appear",
    };

    assert.equal(
      await runCli(["setup", "--bot-id", "bot-1"], env, (line) => output.push(line)),
      0,
    );
    const config = readFileSync(configPath, "utf8");
    assert.deepEqual(JSON.parse(config), { bot_id: "bot-1" });
    assert.equal(config.includes(env.WECOM_BOT_SECRET), false);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);

    output.length = 0;
    assert.equal(await runCli(["doctor"], env, (line) => output.push(line)), 0);
    assert.match(output.join("\n"), /Live connection: not visible to this standalone CLI/);
    assert.equal(output.join("\n").includes(env.WECOM_BOT_SECRET), false);

    setWeComInboxRootForTests(env.REGENIC_WECOM_INBOX_DIR);
    rememberWeComMessage("bot-1", {
      msg_id: "msg-1",
      conversation_id: "chat-1",
      conversation_title: "工程群",
      chat_mode: "group",
      create_at: 1_798_000_000_000,
      sender_id: "user-1",
      sender_label: "小明",
      text: "你好",
      msg_type: "text",
    });
    output.length = 0;
    assert.equal(await runCli(["conversations"], env, (line) => output.push(line)), 0);
    assert.deepEqual(output, ["chat-1\tgroup\t工程群"]);
    output.length = 0;
    assert.equal(await runCli(["messages", "chat-1"], env, (line) => output.push(line)), 0);
    assert.match(output[0], /小明\t你好$/);
  });

  it("surfaces corrupted local inbox data instead of reporting an empty inbox", async () => {
    root = mkdtempSync(join(tmpdir(), "wecom-cli-corrupt-"));
    const inbox = join(root, "inbox");
    setWeComInboxRootForTests(inbox);
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "bot-1.json"), "{not json");
    await assert.rejects(() =>
      runCli(
        ["doctor"],
        {
          REGENIC_WECOM_CONFIG: join(root, "config.json"),
          REGENIC_WECOM_INBOX_DIR: inbox,
          WECOM_BOT_ID: "bot-1",
        },
        () => {},
      ),
    );
  });

  it("does not echo unknown command arguments and shows the latest cached messages", async () => {
    root = mkdtempSync(join(tmpdir(), "wecom-cli-output-"));
    const inbox = join(root, "inbox");
    const configPath = join(root, "config.json");
    setWeComInboxRootForTests(inbox);
    writeFileSync(configPath, JSON.stringify({ bot_id: "bot-1" }));
    for (let index = 0; index < 60; index += 1) {
      rememberWeComMessage("bot-1", {
        msg_id: `msg-${index}`,
        conversation_id: "chat-1",
        chat_mode: "group",
        create_at: index + 1,
        sender_id: "user-1",
        text: `message-${index}`,
        msg_type: "text",
      });
    }

    const output = [];
    const errors = [];
    assert.equal(
      await runCli(
        ["do-not-print-this-secret"],
        { REGENIC_WECOM_CONFIG: configPath },
        (line) => output.push(line),
        (line) => errors.push(line),
      ),
      2,
    );
    assert.doesNotMatch(errors.join("\n"), /do-not-print-this-secret/);

    assert.equal(
      await runCli(
        ["messages", "chat-1"],
        { REGENIC_WECOM_CONFIG: configPath, REGENIC_WECOM_INBOX_DIR: inbox },
        (line) => output.push(line),
      ),
      0,
    );
    assert.equal(output.length, 50);
    assert.match(output[0], /message-10$/);
    assert.match(output[49], /message-59$/);
  });
});
