# 企业微信连接器

Regenic 的企业微信会话连接器。形态对齐飞书连接器：一个 `ChannelDriver` 负责安装、会话目录和回复，每条会话一个 poll stream，回复走同一个安装上的 egress。

企业微信没有飞书 `lark-cli` 那种用户态历史拉取。这个连接器用官方 [`@wecom/aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk) 建立智能机器人长连接，收 `aibot_msg_callback`，再用 `sendMessage` 把 Markdown 回复发回群或单聊。连接建立之前的历史不会补拉。群消息只有有人 @机器人 时才会进来；机器人要先收到该会话的一条消息，之后才能主动回复。

## 在企业微信后台

1. 打开企业微信管理后台，创建一个智能机器人。
2. API 模式选择 **长连接**，不要同时启用「设置接收消息回调地址」。记下 Bot ID 和 Secret。
3. 发布机器人。单聊里给它发一条消息，或在群里 @它，会话才会出现。

协议见[智能机器人长连接](https://developer.work.weixin.qq.com/document/path/101463)。

## 在 Regenic 里加载

本包是 extra plugin。它依赖本机的 Regenic 仓库（`@regenic/connector-contract` 和 `@regenic/plugin-host`）。

```bash
export REGENIC_ROOT=/path/to/regenic
pnpm install
pnpm build
```

把构建好的目录放到插件目录下，目录名任意，里面要有 `package.json`：

```bash
mkdir -p ~/.regenic/plugins
ln -s "$PWD" ~/.regenic/plugins/wecom-connector
```

也可以不复制目录，直接指定这一个包：

```bash
export REGENIC_CHANNEL_PLUGIN=/path/to/wecom-connector
```

安装卡片里填写 Bot ID。Secret 会进系统钥匙串，不会写进安装配置。也可以用环境变量 `WECOM_BOT_ID` 和 `WECOM_BOT_SECRET` 作为无界面安装的后备。

## 本地 CLI

构建后可用 `node dist/cli.js` 运行本地 CLI；安装包也提供 `wecom-connector` 命令：

```bash
wecom-connector setup --bot-id <Bot-ID>
wecom-connector doctor
wecom-connector conversations
wecom-connector messages <会话 ID>
```

`setup` 只保存 CLI 本地选择用的 Bot ID，不会创建或修改 Regenic 安装，也不设置 Secret。配置默认保存在 `~/.regenic/wecom-cli.json`；可用 `REGENIC_WECOM_CONFIG` 指定配置文件，或用 `REGENIC_HOME` 指定 Regenic 主目录。Bot Secret 不接受为命令行参数，也不会写入此配置文件；Secret 仍需在 Regenic 安装设置中配置，或通过 `WECOM_BOT_SECRET` 提供给 Regenic 主进程。

`doctor` 只检查本地配置与已收到消息的缓存，不会建立 WeCom 长连接，也看不到 Regenic 主进程当前的连接状态。CLI 和 Regenic 共用同一机器人连接；独立启动第二个连接会导致 WeCom 踢掉先前连接。`conversations` 和 `messages` 只显示此机器人已经收到并保存在本机的数据，不会补拉连接建立前的历史。

同步范围：

- **最近活跃**：跟进最近发到机器人的会话。
- **全部**：跟进所有会发到机器人的群和单聊。
- **自选**：粘贴群 `chatid` 或单聊 `userid`，多个用逗号分隔。

每个会话的发送上限是 30 条/分钟、1000 条/小时。同一机器人同一时间只能保持一条长连接。新的订阅会踢掉旧连接，SDK 收到 `disconnected_event` 后这个进程不再重连。

## 开发

`REGENIC_ROOT` 指向 Regenic 仓库，或把该仓库放在本目录的上一级。测试会链接其中已经构建的 contract 包。

```bash
pnpm --dir "$REGENIC_ROOT" --filter @regenic/plugin-host --filter @regenic/connector-contract --filter @regenic/connector-test-utils build
pnpm test
```
