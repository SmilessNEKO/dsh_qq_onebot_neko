# dsh-qq-bot

把已经在用的 DSH 会话接到 QQ 个人号。协议是 OneBot，常用实现是 NapCat。

Cordis 插件 id 是 `qq-bridge`。npm 包名是 `@fengye_nobug/dsh-qq-bot`。界面显示名是 dsh-qq-bot。

唤醒、出站、图片、NapCat 和全部设置项见 [`DESIGN.md`](./DESIGN.md)。变更见 [`CHANGELOG.md`](./CHANGELOG.md)。

## 简介

消息进入你指定的会话，回答可以发回 QQ。白名单默认全关。被 @、叫到昵称或被戳时会叫醒；其余消息按概率抽样。群白名单可以由主人在 QQ 里用整句命令修改。

## 功能

- 接到一个已有会话，或按群、按私聊各记一条会话。
- 白名单留空时，任何群和私聊都不会叫醒。
- 被 @、命中昵称、被戳一定叫醒。其余按 `wakeProbability`（默认 `0.05`）抽样，没抽中只记录。
- 主人的私聊（`ownerWhitelist` 里的号）一律叫醒、不参与抽签；`alwaysWakePrivate` 置 `false` 可关掉。别人的私聊和所有群不受影响。
- 插件中途重载（改设置、更新插件）不会让正在回答的那一轮消息丢掉：待回复的目的地会落一份到状态文件，重载后照样发得出去。
- 发回 QQ 的内容由 `replyMode` 决定。在 DSH 界面里聊同一个会话时，正文不会进群。
- 一轮里写多个 `[QQ]` 块时分条发出，相邻两条之间隔 `replyGapMinMs`–`replyGapMaxMs`（默认 1.2–2.8 秒随机），不会一口气刷屏。
- 图片先落盘，叫醒时写成文字。表情包可以登记后再发。半角方括号里的 `[表情名]` 会变成 QQ 系统表情。
- 图片先落盘，叫醒时一律交给识图模型读成一句话，不再按体积分档（`imageDescribeSafeBytes` / `imageDescribeMaxBytes` / `imageWakeTotalBytes` 三项从此不再生效，保留只为兼容旧配置）。一次唤醒最多识别 3 张，其余留 `[图片#短哈希]` 占位。识图被 token 上限截断会自动翻倍预算重试（最多三次），三次都不行就在正文写「描述失败」。`describeImages` 关掉则完全不识图、只留占位——适合会话模型自己能看图时省调用。
- perGroup 下会话会自动轮换：聊到 `rotateMaxTurns`（默认 300 轮）或上下文占用达到 `rotatePressureRatio`（默认 `0.75`）时就新建一条会话接着聊，旧会话留在面板里可查、不会被删。`rotateEnabled` 置 false 可关掉。目的是不让长群聊撞上模型窗口上限后每轮都失败。
- 新建的 QQ 会话会挂到「QQ 桥接」工作区，面板里按目录分组显示，不散落在最近会话里。
- 设置卡片在 **设置 → 插件 → 插件配置 → QQ 桥接**。可以检查更新；有新正式版时一键安装，并重启面板。
- 可以按需下载、配置、启停 NapCat。下载 / 安装 / 写配置默认都要显式触发，插件加载时不会自己下载或安装。
- **DSH 启动后自动拉起 NapCat**：打开 `autoStartNapcat`（默认关），DSH 启动延迟 `autoStartNapcatDelayMs`（默认 `20000` = 20 秒，可调 0–600000）后自动启动**已经装好、并登录过一次**的 NapCat。只调用现成的启动逻辑，绝不自动下载 / 安装 / 写配置；到点会重读开关、确认 NapCat 没在运行才启动，等待期间关掉开关、插件被卸载或 NapCat 已在跑都会跳过，启动失败只记一条日志。
- **识图改成下拉选择，不用手写模型名**：`visionMode` 三选一 —— `auto` 自动找一个支持图片输入的模型、`session` 用会话当前模型、`fixed` 从 DSH 已配置的提供商里选一个、再选它下面的模型（两段联动下拉，模型清单带「支持识图」标记）。旧的 `visionModel`（`provider/model`）只是没配新选项时的兜底，卡片上不再给输入框。
- **每个群 / 私聊可以单独个性化**（`destinationProfiles`，按 `group:<群号>` / `private:<QQ号>`）：休眠时段（如 `23:00-08:00`，期间只记账不回复）、`alwaysReply`（给主人的私聊打开 = 24 小时实时回复，不受休眠约束）、连发等待 `burstWaitMs` 与停听 `idlePauseMs`。这几项只对该目的地生效，覆盖全局同名设置；卡片里可从已接入的目的地直接挑，不用背群号。
- **连发会等停手再回**：对方连着发消息时先攒着，`burstWaitMs`（默认 `0` = 立刻回，可调，例如 5 秒）内没人接着说才回复；会话跟随窗口空闲 `listenIdleMs`（默认 `120000` = 2 分钟）没有新消息就自动停听，等下一条消息再续，不会一直挂着烧 token。
- **模型优先级链**：`modelChain` 从 DSH 已配置提供商 / 模型里排出一串顺序，当前模型连续报错 `modelChainFailures`（默认 `5`）次后自动切到下一个，循环回绕；切换走宿主 `agent.model.select`，不用重建会话。新建会话默认模型（`newSessionModel` 留空时）也跟着链首走。
- **新建 QQ 会话可指定落点**：`newSessionDir`（文件夹，空 = 「QQ 桥接」工作区）、`newSessionModel`（默认模型）、`newSessionPreset`（默认预设模式）都能在卡片里选，不填就沿用宿主默认。

不做审批桥接，也不走 QQ 官方机器人。

## 安装

日常安装用 npm 上已经发出的版本。仓库源码如果比已发布的版本新，不要直接装 main。

```sh
dsh plugin --profile web add @fengye_nobug/dsh-qq-bot@0.2.5
```

registry 里还没有这一版时：

```sh
dsh plugin --profile web add github:yunfengnobug/dsh-qq-bot#v0.2.5
```

装完重启 dsh-web。

环境：DSH 0.1.5-rc.3，或 0.2.0 及以后；Node ≥ 22；NapCat 的 OneBot v11 正向 WebSocket。

`cordis.patch.yml` 里 `qq-bridge` 的 `name` 写成 `@fengye_nobug/dsh-qq-bot`。写成 `dsh-qq-bot` 或 `dsh-qq-bridge` 时插件挂不上，设置接口是 HTTP 404。

不要和另一个 Cordis id 也是 `qq-bridge` 的 QQ 插件一起挂，它们会抢同一条 OneBot。已经装着 `dsh-qq-bridge` 时，先卸掉再装上面的包，然后重启。profile 里按 `id: qq-bridge` 写的覆盖可以留着；其中的 `name` 同样写成 `@fengye_nobug/dsh-qq-bot`。

升级的几条路径、开发期怎么链到本地目录，见 [`DESIGN.md`](./DESIGN.md) 的「使用细节」。

## 配置

白名单默认全关。先在设置卡片里填「哪些群可以叫醒」或「哪些私聊可以叫醒」，保存后再去 @。不要把真实群号、QQ 号写进仓库。

群白名单仍按群号填写。连上之后，卡片里每个群号旁边会显示当前群名和头像。没连上，或暂时查不到，就只显示群号，保存不受影响。

DSH 0.2 的卡片把值写进 `$DSH_HOME/qq-bridge-settings.json`。这份文件比 `cordis.patch.yml` 优先，保存后马上生效，重启还在。只改 `cordis.patch.yml` 要重启。

主人 QQ 在设置卡片里就叫「主人 QQ」（`ownerWhitelist`，默认 `[]`）。只有这些号能在 QQ 里改群白名单。**留空 = 这些命令不会生效。** 多个号用逗号分开。保存后下一条消息就生效。只改 `cordis.patch.yml` 要重启；设置文件里已有同名键时，以设置文件为准。

`accessTokenEnv` 填凭据引用名（一个环境变量名）。token 由 DSH 凭据服务解析，不要写进配置文件。每次建连重新解析。

| 键 | 默认 | 效果 |
|---|---|---|
| `targetSessionId` | 空 | `single` 时接到哪个会话。留空 = 不接到任何会话 |
| `sessionScope` | `single` | `perGroup` 时每个群、每个私聊各一条会话 |
| `maxRecentTurns` | `40` | 每个会话最多留几轮。QQ 一轮结束并空闲后，更早的内容会尽量压缩掉。用的是这条会话自己的压缩（标准人设里就有）。人设没有时再看会话作用域和宿主。已经超限却找不到压缩，或这次压缩没有改动会话时，记一条警告。`0` = 不限制 |
| `nicknames` | `244`、`小助手` | 听到这些名字就叫醒 |
| `wakeProbability` | `0.05` | 没点名时的叫醒概率 |
| `alwaysWakePrivate` | `true` | 主人的私聊必回：`ownerWhitelist` 里的号发来的私聊一律叫醒、不参与抽签。别人的私聊和所有群不受影响。关掉就回到按概率 |
| `whitelist` | `[]` | 哪些私聊可以叫醒。留空 = 都不叫醒 |
| `groupWhitelist` | `[]` | 哪些群可以叫醒。留空 = 都不叫醒。卡片里查到群名时，群号旁边有名字和头像 |
| `ownerWhitelist` | `[]` | 卡片里叫「主人 QQ」。留空 = 不能在 QQ 里改群白名单 |
| `onebotUrl` | 空 | NapCat 正向 WebSocket。留空 = 不连接 |
| `atOnlyInGroup` | `false` | 打开后，群里没被 @ 就不处理 |
| `replyMode` | `marker` | 群里发出去的是哪一段：只发「发给群」里的那段 |
| `visionMode` | `auto` | 识图用哪个模型：`auto` 自动找支持图片输入的、`session` 用会话当前模型、`fixed` 用下面两项选的 |
| `visionProvider` / `visionProviderModel` | 空 | `visionMode=fixed` 时，从 DSH 已配置提供商及其模型里两段联动下拉选；不手写模型名 |
| `modelChain` | `[]` | 模型优先级链，从已配置提供商 / 模型里排顺序；连续报错达阈值自动切下一个 |
| `modelChainFailures` | `5` | 链上当前模型连续报错几次后切到下一个（1–50） |
| `newSessionDir` | 空 | 新建 QQ 会话放到哪个文件夹（绝对路径）；空 = 「QQ 桥接」工作区 |
| `newSessionModel` | 空 | 新建会话默认模型；空 = 宿主默认模型或 `modelChain` 第一个 |
| `newSessionPreset` | 空 | 新建会话默认预设模式 |
| `destinationProfiles` | `[]` | 按 `group:<群号>` / `private:<QQ号>` 分别设休眠时段、24 小时实时回复、连发等待、停听时间 |
| `replyGapMinMs` / `replyGapMaxMs` | `1200` / `2800` | 一轮里分条发出时，两条之间随机间隔的下限 / 上限（毫秒）；写反会自动换过来 |
| `burstWaitMs` | `0` | 对方连着发消息时，先等这么多毫秒没人再说才回复；`0` = 立刻回。每个目的地可单独覆盖 |
| `listenIdleMs` | `120000` | 会话跟随期间，这么久（毫秒）没有新消息就自动停听；默认 2 分钟 |
| `autoStartNapcat` | `false` | DSH 启动后自动拉起**已装好**的 NapCat。默认关；只启动，绝不下载 / 安装 / 写配置 |
| `autoStartNapcatDelayMs` | `20000` | 自动启动前的等待毫秒数（0–600000，默认 20 秒）；填 0 = 起来就立刻尝试。到点会重读开关、确认 NapCat 没在跑才启动，失败只记日志 |

其余键见 [`DESIGN.md`](./DESIGN.md)。

识图服务商、模型优先级链、新会话默认模型与预设、以及每个目的地的个性化，都在设置卡片里用下拉 / 勾选完成：卡片会向 `/api/qq-bridge/catalog`（已配置提供商、各提供商的模型、是否支持识图、预设列表）和 `/api/qq-bridge/profiles`（已接入的群 / 私聊）取清单，不用手抄 id。刚装好、清单还没拉到时，对应下拉会先退化成一个可手填的输入框，拉到之后自动变成选项。两个接口都是只读，准入和设置接口相同。

## 使用

在群里 @ 机器人，或叫出昵称。白名单没填时不会醒。

主人改群白名单时，整句必须就是命令，前面可以加一个 `/`。多出来的字不当命令。不是主人时按普通聊天处理：不改配置，也没有单独的拒绝回复。还没进白名单的群，主人仍能在群里直接加。调试工具模拟的消息不会改白名单。

| 在哪 | 整句 | 作用 |
|---|---|---|
| 群里 | `白名单 加`、`白名单 加本群` | 把当前群加进群白名单 |
| 群里 | `白名单 删`、`白名单 删本群` | 把当前群移出 |
| 群或私聊 | `白名单 加 群号`、`白名单 删 群号` | 按写明的群号加或删 |
| 群或私聊 | `白名单`、`白名单 列表` | 回复现在有几个群 |
| 私聊 | `白名单 加`（没写群号） | 不改配置，提示要写群号 |

删到一个群都不剩时，回复会说明现在任何群都不会叫醒。保存方式和设置卡片相同。

`replyMode` 为 `marker` 时，模型把要发到群里的话放进 `[QQ]…[/QQ]`。一轮里可以放多个块，会按顺序一条一条发出去（引用只挂在第一条上），不会再被拼成一条带空行的长消息。会话跟随、表情包和戳一戳见 [`DESIGN.md`](./DESIGN.md)。

## 更新

设置卡片里先点「检查更新」。有新正式版时点「更新到 vX.Y.Z」。优先从 npm 安装；这一版还没发到 npm 时，改从 GitHub 下载。装完会自己重启 dsh-web。设置还在，不改 NapCat。刷新页面后，登录口令可能会变。

0.2.12 起，重启后如果 `$DSH_HOME/.agent-presets/dsh-qq-bridge/skills/qq-session-reply-style/references/reply-style.md` 里还有 “Emoji are welcome when they make the answer friendlier.”，会删掉这一句。「Avoid Markdown formatting. Use plain text.」还在，其它行不动，也不另写禁用表情的规矩。这份文件本来没有时不会新建。不用删掉整个人设目录。已经读进当前会话的旧规则，要等下次再读这份说明，或另开一条会话。

「检查更新」和「启动时检查一次」只询问，不会安装。

维护者发版：

1. 改 `package.json` 的 `version`。
2. 在 [`CHANGELOG.md`](./CHANGELOG.md) 顶部写这一版。
3. 推到 `main`。

推到 `main` 后，Actions 在 npm 上还没有 `@fengye_nobug/dsh-qq-bot` 的这一版时才发布，并补 tag `vX.Y.Z` 和 GitHub Release。`NPM_TOKEN` 放在仓库 Actions Secrets，不写进仓库。

## 许可

MIT。详见 [`LICENSE`](./LICENSE)。本插件基于 sj244 的 dsh-qq-bridge（MIT）。
