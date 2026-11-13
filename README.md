# dsh-qq-bridge-neko

把已经在用的 DSH 会话接到 QQ 个人号。协议是 OneBot，常用实现是 NapCat。

一个**独立身份**的 DSH 插件：Cordis 插件 id `qq-bridge-neko`，设置命名空间 `qq-bridge-neko`，接口 `/api/qq-bridge-neko/...`，工具 `qq_bridge_neko_*`，状态文件 `qq-bridge-neko-*.json`，设置卡片叫「QQ 桥接 Neko」，注入 QQ 消息的来源是 `plugin:dsh-qq-bridge-neko`。可以和旧的 `qq-bridge` 插件并存在同一个 profile 里。

**这个插件不发 npm。** 仓库 `package.json` 里的 `name`（`dsh-qq-bridge-neko`）只用来给安装后的目录命名、让 Cordis 按包名解析到模块，它**从来没有发布到 npm registry**：`npm view dsh-qq-bridge-neko` 会 404。安装只走本地 `.tgz` 或本仓库的 GitHub tag，见[安装](#安装)。

---

## 目录

- [功能](#功能)
- [安装](#安装)
- [配置](#配置)
- [使用](#使用)
- [更新](#更新)
- [排障](#排障)
- [发版（本地维护）](#发版本地维护)
- [许可](#许可)

细节设计、唤醒状态机、出站闸门、NapCat 管理、全部设置项见 [`DESIGN.md`](./DESIGN.md)；变更见 [`CHANGELOG.md`](./CHANGELOG.md)。

## 功能

**唤醒与出站**

- 接到一个已有会话，或按群、按私聊各记一条会话（`sessionScope`）。
- 白名单默认全关：留空时任何群和私聊都不会叫醒。
- 被 @、命中昵称、被戳一戳一定叫醒。其余消息按 `wakeProbability`（默认 `0.05`）抽样，没抽中只记录。
- 主人的私聊（`ownerWhitelist` 里的号）一律叫醒、不参与抽签；`alwaysWakePrivate` 置 `false` 可关掉。别人的私聊和所有群不受影响。
- 发回 QQ 的内容由 `replyMode` 决定。在 DSH 界面里聊同一个会话时，正文不会进群。
- 没指定发给谁（既没传群号/私聊号，也没有被 QQ 消息钉住）时，默认沿用最后一次入站消息的目的地；打开 `fallbackToOwnerPrivate` 改成一律发主人私聊。改写目的地时不会带原来那个群的引用。
- 一轮里写多个 `[QQ]` 块时分条发出，相邻两条之间隔 `replyGapMinMs`–`replyGapMaxMs`（默认 1.2–2.8 秒随机），不会一口气刷屏。
- 插件中途重载（改设置、更新插件）不会让正在回答的那一轮消息丢掉：待回复的目的地会落一份到状态文件，重载后照样发得出去。

**图片与表情包**

- 图片先落盘，叫醒时一律交给识图模型读成一句话。一次唤醒最多识别 3 张，其余留 `[图片#短哈希]` 占位。识图被 token 上限截断会自动翻倍预算重试（最多三次），三次都不行就在正文写「描述失败」。
- `describeImages` 关掉则完全不识图、只留占位——适合会话模型自己能看图时省调用。
- 表情包可以用 `qq_bridge_neko_sticker` 收藏群友发的图或 QQ 商城表情，再按情绪 / 哈希发出去。半角方括号里的 `[表情名]` 会变成 QQ 系统表情。

**会话**

- perGroup 下会话会自动轮换：聊到 `rotateMaxTurns`（默认 300 轮）或上下文占用达到 `rotatePressureRatio`（默认 0.75）时就新建一条会话接着聊，旧会话留在面板里可查、不会被删。`rotateEnabled` 置 `false` 可关掉。目的是不让长群聊撞上模型窗口上限后每轮都失败。
- **手动归档后会自动新建**：你在面板里把当前 QQ 会话归档，下一条消息进来时插件发现目的地指向的会话已在归档清单里，就按 `newSessionDir` / 模型 / 预设重新建一条接着聊，不用等轮换条件。归档不会删会话文件，所以这条判断只看归档清单。
- 新建的 QQ 会话会挂到工作区：`newSessionDir` 留空时挂到「QQ 桥接」，填了文件夹就挂到该目录同名的工作区（目录不存在会自动创建），面板里按目录分组显示，不散落在最近会话里。
- **模型优先级链**：`modelChain` 从 DSH 已配置提供商 / 模型里排出一串顺序，当前模型连续报错 `modelChainFailures`（默认 `5`）次后自动切到下一个，循环回绕；切换走宿主 `agent.model.select`，不用重建会话。新建会话默认模型（`newSessionModel` 留空时）也跟着链首走。
- **新建 QQ 会话可指定落点**：`newSessionDir`（文件夹，空 = 「QQ 桥接」工作区）、`newSessionModel`（默认模型）、`newSessionPreset`（默认预设模式）都能在卡片里选，不填就沿用宿主默认。`sessionScope = single` 时目标会话由 `targetSessionId` 指定，被归档不会自动换——插件会在台账里记一条 `wake-failed` 并说明原因，需要你取消归档或改用 perGroup。
- **顺手清掉没用的空白会话**（`pruneBlankSessions`，默认开）：新建 QQ 会话前，把同一个文件夹里「从没跑过一轮」的会话归档掉。原因是 DSH 面板点「新建会话」时会优先**复用**同目录下的空白会话（宿主判据只有一条：有没有 `turn/start`），所以手开过又没聊过的空壳会一直挡在前面，每次点新建都拿回同一条旧的。只碰这个目录、只碰没有 `turn/start` 的、正在跑的和 `sessionByDest` 还指着的都跳过；归档可撤销（面板里取消归档即可恢复），不影响新建本身。关掉它也不会坏事，只是空壳会继续被复用。
- **会话跟随**：模型可以调 `qq_bridge_neko_listen` 开一段 5–60 分钟的跟随窗口，窗口内同一个群 / 私聊的普通消息也会叫醒，不必每条都 @。`listenIdleMs`（默认 2 分钟）没有新消息就自动停听，不挂着烧 token。

**语音**

- 打开 `voiceEnabled`（默认关）后，正文里写 `[语音]要念的台词[/语音]`，这句话会被合成成语音发出去（一个语音块 = 一条 QQ 消息，文字块照旧分条），语音前后的文字还是正常文字。
- 也可以直接调 `qq_bridge_neko_voice` 工具，用 `voice` / `rate` / `pitch` / `style` 单次覆盖参数，`provider` 单次切换引擎。
- **两套声音，二选一**（设置卡片「声音」页最上面那两块）：
  1. **本地合成**：可选 `edge`（本机 `edge-tts`）或 `sherpa`（本机离线模型）；
  2. **肥鱼声音服务**：本机 HTTP 服务，声音更像人，也是唯一能唱歌的一条。

  选中哪一套就只显示哪一套的字段（本地那套：`ttsVoice` / `ttsRate` / `ttsPitch` / `ttsPythonPath` / `ttsSid` / `ttsSpeed` / `ttsModelDir`；肥鱼那套：`feiyuBaseUrl` / `feiyuApiKey` / `feiyuVoice` / `feiyuStyle` / 三个超时 / `voiceMaxSongChars` / 四个自动启停键）。另一套只是收起来，**值不会被清空**，切回去还在。存储上仍然只有一个键 `ttsProvider`（`edge` / `sherpa` / `feiyu`），老配置文件照旧生效。
- 具体引擎（`ttsProvider` 三选一的那三个值）：
  - `edge`（默认）：合成走本机的 `edge-tts`（`ttsPythonPath` 指向装了它的解释器），音色 / 语速 / 音高是 `ttsVoice` / `ttsRate` / `ttsPitch`，产物是 mp3。不动这个键时行为跟以前完全一样。
  - `sherpa`：合成走本机的离线模型（`sherpa_onnx`，不联网），模型目录 `ttsModelDir`（留空 = `$DSH_HOME/tts-models/vits-melo-tts-zh_en`），说话人 `ttsSid`（默认 0）、语速倍数 `ttsSpeed`（默认 1），音色名仍读 `ttsVoice`，产物是 mp3；解释器同样用 `ttsPythonPath`。
  - `feiyu`：合成走你自己部署的**肥鱼声音服务**（本机 HTTP 服务）——先把服务起起来，再把 `ttsProvider` 选成 `feiyu`。地址是 `feiyuBaseUrl`（默认 `http://127.0.0.1:9880`，带路径前缀也行），服务要鉴权就把 Bearer 口令填进 `feiyuApiKey`（留空 = 不带鉴权头；卡片上不回显已存的口令，留空即不改）。音色 `feiyuVoice` 是**下拉**（默认 `feiyu`），语气 `feiyuStyle` 二选一（`cute` 软萌 / `gentle` 温柔）。下拉的清单不是写死的：设置卡片会去打服务的 `GET /v1/capabilities`，把 `tts[]` / `rvc[]` 里注册的音色投影成选项（标签上带每个音色支持的语气，RVC 包标「换声」，`available: false` 的标「当前不可用」）；服务没起、口令不对或一个音色都没注册时退回内置的 `feiyu` 一项，并在下拉下面写一句原因 —— 卡片不会因此变空或报错。配置里存着的音色若不在清单里，会保留成「当前值，不在清单里」的兜底项，不会被静默清空。产物是 wav：有 ffmpeg 就转成 mp3 再发（`ffmpegPath` 留空时先找 PATH 上的 `ffmpeg`，再找本机约定的那个；都没有 / 转失败就原样发 wav，不算合成失败）。
  - 肥鱼首次请求要加载模型，所以整体超时给得大：`feiyuTimeoutMs` 默认 180000，任务状态按 `feiyuPollIntervalMs` 轮询（默认 1000）。服务没起来 / 口令不对 / 任务失败都**降级发文字**，不会卡住也不整条消失。
  - **服务自动启停**（插件自己管，不用人盯着）：每次合成前先探一下 `GET /health`（这个接口免鉴权）。通就直接合成；不通且 `feiyuAutoStart` 开着，就按 `feiyuServerDir` + `feiyuPythonPath` 把服务拉起来（等 `/health` 通，最多 `60` 秒），然后再合成。合成成功会刷新「最后使用时间」，空闲到 `feiyuIdleStopMinutes`（默认 10 分钟，填 `0` = 一直开着）就停服务：先发 `POST /v1/admin/shutdown` 让它自己走完收尾（释放显存、等队列排空才退），接口不认或不通才 kill **插件自己启动的那个进程**；别人手工起的服务只发 shutdown，绝不动手杀。同一地址并发请求只拉起一次，不会两个进程抢同一个端口。
  - **音质**：wav 转 mp3 时会过一条轻量滤镜链（80Hz 高通 / 12kHz 低通 / 200Hz 与 3kHz 各 +1.5dB / 2.5:1 轻压缩 / `loudnorm` 到 -16 LUFS），输出 44.1kHz、96kbps。ffmpeg 太老缺某个滤镜时**退一步**用无滤镜参数再转一次 —— 宁可音色差一点，也别发不出声。
  - **ffmpeg 怎么找**：设置的 `ffmpegPath` → 环境变量 `DSH_TTS_FFMPEG` → PATH 上的 `ffmpeg`。**包里不再内置任何本机绝对路径**，换台机器装也能用；全都没有就原样发 wav（不算合成失败）。
- 单条语音上限 `voiceMaxChars`（默认 120 字）。
- 合成失败或超长时**降级发文字**（正文前加「（语音没合成出来）」），不会整条消失。同一句话 + 同一引擎 + 同一组参数只合成一次，缓存在 `voiceCacheDir`。关着开关时标记原样当文字发，不静默吞字。

**唱歌**

- 调 `qq_bridge_neko_sing` 工具，把一段**原创小曲**唱出来发到 QQ：`score` 给 ABC 记谱的单音主旋律，`lyrics` 给逐字歌词（只能有汉字，标点空格忽略），可选 `transpose`（移调半音）、`bpm`（覆盖谱面速度）、`pinyin`（逐字拼音，纠正多音字）。
- 一个音符一个字，**一字多音用 `_` 占位**；歌词字数要等于音符数。
- 只有 `ttsProvider = feiyu` 时唱得出来（唱歌 = SVS 出声 + RVC 换声，都在肥鱼服务里）；别的引擎会降级发文字说明，不会假装唱了。
- 唱歌比说话慢一个量级（谱面编译 → 分段 SVS → RVC → 混音），所以超时单独一个键 `feiyuSingTimeoutMs`（默认 600000 = 10 分钟），轮询沿用 `feiyuPollIntervalMs`。
- 一首歌的歌词上限 `voiceMaxSongChars`（默认 400 字，约两三分钟）；超了直接拒唱并说明，不偷偷截断。
- 合成失败同样**降级发文字**（正文前加「（歌没唱出来）」）。同一份谱 + 同一份词 + 同一个音色只合成一次，缓存在 `voiceCacheDir`。
- 谱子得是原创或公有旋律，别拿别人的版权歌来点。

**设置卡片与 NapCat**

- **入口在 DSH 设置页**：设置左侧导航里多一节「QQ 桥接 Neko」（`settings.section` 座位，和「内置插件」「Vision Router」并列）。以前那个左下角侧栏按钮已经撤掉——同一个设置有两个入口，找起来反而更乱。（插件页那几处入口仍在：设置 → 插件 → 插件配置 → QQ 桥接 Neko。）可以检查更新；有新正式版时一键安装，并重启面板。
- **设置分页**：六十多个键铺成一长条谁也看不下去，现在按主题分成「连接 / 唤醒 / 会话 / 回复 / 声音 / 看图 / 模型 / NapCat / 关于」几页，顶上点页签切换，一次只看一页。新加的键漏了归类会自动落进「其他」页，不会出现「哪页都点不到」。切换页签不影响未保存的改动，保存仍是整张卡片一起存。
- **跟随主题配色**：卡片里的底色、文字色、边框全部走宿主的 `--dsw-*` 设计令牌（`--dsw-alias-bg-layer-2` / `--dsw-alias-label-primary` / `--dsw-alias-border-l2` / `--dsw-specific-input-major`），亮色暗色各有一套值自动切换，不再有硬编码 `#fff` 造成的白底白字。原生下拉的弹层不吃 `<select>` 的配色，所以每个 `<option>` 也单独上了 `background` / `color`，展开时同样是暗色而不是纯白。
- 可以按需下载、配置、启停 NapCat（`qq_bridge_neko_napcat`，action = `status` / `download` / `configure` / `launch` / `stop`）。下载 / 安装 / 写配置默认都要显式触发，插件加载时不会自己下载或安装。
- **DSH 启动后自动拉起 NapCat**：打开 `autoStartNapcat`（默认关），DSH 启动延迟 `autoStartNapcatDelayMs`（默认 `20000` = 20 秒，可调 0–600000）后自动启动**已经装好、并登录过一次**的 NapCat。只调用现成的启动逻辑，绝不自动下载 / 安装 / 写配置；到点会重读开关、确认 NapCat 没在运行才启动，等待期间关掉开关、插件被卸载或 NapCat 已在跑都会跳过，启动失败只记一条日志。
- **识图用下拉选择，不用手写模型名**：`visionMode` 三选一 —— `auto` 自动找一个支持图片输入的模型、`session` 用会话当前模型、`fixed` 从 DSH 已配置的提供商里选一个、再选它下面的模型（两段联动下拉，模型清单带「支持识图」标记）。旧的 `visionModel`（`provider/model`）只是没配新选项时的兜底，卡片上不再给输入框。

**按目的地个性化**

- `destinationProfiles`（按 `group:<群号>` / `private:<QQ号>`）：休眠时段（如 `23:00-08:00`，期间只记账不回复）、`alwaysReply`（给主人的私聊打开 = 24 小时实时回复，不受休眠约束）、连发等待 `burstWaitMs` 与停听 `idlePauseMs`。这几项只对该目的地生效，覆盖全局同名设置；卡片里可从已接入的目的地直接挑，不用背群号。
- **连发会等停手再回**：对方连着发消息时先攒着，`burstWaitMs`（默认 `0` = 立刻回，可调，例如 5 秒）内没人接着说才回复。

不做审批桥接，也不走 QQ 官方机器人。

## 安装

前置：DSH **0.1.5-rc.3**，或 **0.2.0** 及以后；Node **≥ 22**；一个能开「正向 WebSocket」的 NapCat（OneBot v11）。

### 1. 装插件

本仓库不发 npm，所以只有这两条装法。

**A. 本地打好的包**（`npm pack` 产物，文件名形如 `dsh-qq-bridge-neko-1.1.6.tgz`，`.gitignore` 已忽略 `*.tgz`，不入库）：

```sh
dsh plugin --profile web add "<本地 .tgz 的绝对路径>"
```

**B. 从本仓库的 GitHub tag 装**（不用先下载）：

```sh
dsh plugin --profile web add github:SmilessNEKO/dsh_qq_onebot_neko#v1.1.3
```

装完**重启 dsh-web 并刷新页面**（浏览器半的 bundle 只在启动时扫一遍，不重启卡片不会出现；登录口令可能会变）。

### 2. 挂上 NapCat

1. 装并登录一次 NapCat（也可以用卡片里的「下载 / 配置 / 启动」，或者自己装一份再把 `napcatInstallDir` 指过去）。
2. 在 NapCat 里开**正向 WebSocket**，端口记下来（默认 `3001`）。
3. 设置卡片里把 `onebotUrl` 填成那个地址，例如 `ws://127.0.0.1:3001`。留空 = 完全不启用传输。

### 3. 开白名单

`groupWhitelist` 填能叫醒的群号，`whitelist` 填能叫醒的私聊 QQ 号，`ownerWhitelist` 填主人自己的 QQ（只有这些号能在 QQ 里改群白名单）。**默认全空 = 谁都不理**，这是故意的。

真实群号、QQ 号、token、服务器地址不要写进仓库、Issue 或截图。

### 4. 包名与 Cordis 的对应关系

`cordis.patch.yml` 里 `qq-bridge-neko` 这一行的 `name` 必须等于实际安装的包名，也就是 `dsh-qq-bridge-neko`（`package.json` 的 `name`）。写成别的名字时 Cordis 解析不到模块，插件挂不上、`/api/qq-bridge-neko/settings` 返回 HTTP 404。

v1.1.5 及更早装的是带作用域的 `@fengye_nobug/dsh-qq-bridge-neko`。从那些版本升上来时，插件会在安装完成后自动把 `cordis.patch.yml` 里的 `name` 改成磁盘上的实际包名（`alignCordisNames`），旧目录 `node_modules/@fengye_nobug/dsh-qq-bridge-neko` 也仍会被识别。

profile 里按 `id: qq-bridge-neko` 写的覆盖可以留着，其中的 `name` 同样用上面的包名。这个包名**不代表 npm 上有这个包**——它只是安装目录与模块解析用的标识。

### 与旧插件并存

本插件的 id、命名空间、接口路径、工具名、状态文件名都和旧的 `qq-bridge` 不同，所以可以和它装进同一个 profile：设置页会多出一张卡片，宿主不会按 id 去重把新代码盖掉。两边各自连自己的 OneBot——**别把两边 `onebotUrl` 填成同一个 NapCat**，会抢连接。

开发期怎么链到本地目录（junction、重启流程），见 [`DESIGN.md`](./DESIGN.md) 的「使用细节 → 开发期」。

## 配置

白名单默认全关。先在设置卡片里填「哪些群可以叫醒」或「哪些私聊可以叫醒」，保存后再去 @。

群白名单按群号填写。连上之后，卡片里每个群号旁边会显示当前群名和头像；没连上、或暂时查不到就只显示群号，保存不受影响。

DSH 0.2 的卡片把值写进 `$DSH_HOME/qq-bridge-neko-settings.json`。这份文件比 `cordis.patch.yml` 优先，保存后马上生效，重启还在。只改 `cordis.patch.yml` 要重启。

主人 QQ 在卡片里就叫「主人 QQ」（`ownerWhitelist`）。只有这些号能在 QQ 里改群白名单，**留空 = 这些命令不会生效**。多个号用逗号分开。

`accessTokenEnv` 填凭据引用名（一个环境变量名）。token 由 DSH 凭据服务解析，不要写进配置文件。每次建连重新解析。

| 键 | 默认 | 效果 |
|---|---|---|
| `targetSessionId` | 空 | `single` 时接到哪个会话。留空 = 不接到任何会话 |
| `sessionScope` | `single` | `perGroup` 时每个群、每个私聊各一条会话 |
| `maxRecentTurns` | `40` | 每个会话最多留几轮。QQ 一轮结束并空闲后，更早的内容会尽量压缩掉。已经超限却找不到压缩、或这次压缩没有改动会话时记一条警告。`0` = 不限制 |
| `nicknames` | `244`（随包的 `cordis.patch.yml` 预置 `244`、`小助手`） | 听到这些名字就叫醒 |
| `wakeProbability` | `0.05` | 没点名时的叫醒概率（0–1） |
| `alwaysWakePrivate` | `true` | 主人的私聊必回：`ownerWhitelist` 里的号发来的私聊一律叫醒、不参与抽签。关掉就回到按概率 |
| `whitelist` | `[]` | 哪些私聊可以叫醒。留空 = 都不叫醒 |
| `groupWhitelist` | `[]` | 哪些群可以叫醒。留空 = 都不叫醒。卡片里查到群名时，群号旁边有名字和头像 |
| `ownerWhitelist` | `[]` | 卡片里叫「主人 QQ」。留空 = 不能在 QQ 里改群白名单 |
| `fallbackToOwnerPrivate` | `false` | 没指定发给谁时，默认发给主人私聊（`ownerWhitelist` 第一个号）。关着 = 沿用最后一次入站消息的目的地，在群里聊就发回那个群。显式传 `groupId` / `userId`、或被 QQ 消息钉住的回复不受影响；改写目的地时不再带那条群的引用 |
| `onebotUrl` | 空 | NapCat 正向 WebSocket，例如 `ws://127.0.0.1:3001`。留空 = 不连接 |
| `onebotPort` | `3001` | 卡片里那套 NapCat 配置要用的端口。自己另装的 NapCat 要跟这边一致 |
| `accessTokenEnv` | 空 | 存 access_token 的环境变量名。不写明文 token |
| `selfId` | 空 | 机器人自己的 QQ 号。留空 = 连上后自动读 |
| `atOnlyInGroup` | `false` | 打开后，群里没被 @ 就不处理 |
| `replyWithQuote` | `false` | 回复时引用触发的那条消息 |
| `stripMarkdown` | `true` | 出站前去掉 Markdown 记号（QQ 不渲染） |
| `replyMode` | `marker` | 群里发出去的是哪一段：`marker` 只发 `[QQ]` 块、`tool` 只认发消息工具、`always` 整段进群（慎用） |
| `replyMaxChars` | `1500` | 一条最多多少字，超过就不发 |
| `delivery` | `auto` | 忙的时候怎么插话：`auto` 能插就插、不能就排队；`followup` 一律新开一轮；`steer` 不管忙不忙都插 |
| `describeImages` | `true` | 收到图片时先叫一个模型读成一句话。关掉只留占位，图仍作为附件交给会话 |
| `visionMode` | `auto` | 识图用哪个模型：`auto` 自动找支持图片输入的、`session` 用会话当前模型、`fixed` 用下面两项选的 |
| `visionProvider` / `visionProviderModel` | 空 | `visionMode=fixed` 时，从 DSH 已配置提供商及其模型里两段联动下拉选；不手写模型名 |
| `visionModel` | 空 | 旧写法（`provider/model`），只在新选项都没配时兜底 |
| `rotateEnabled` | `true` | perGroup 下聊得太久 / 上下文快满时自动新建会话接着聊（旧的留着可查） |
| `rotateMaxTurns` | `300` | 同一目的地聊到这么多轮就换新会话。`0` = 只按上下文压力判断 |
| `rotatePressureRatio` | `0.75` | 上下文占用达到这个比例就换新会话。`0` = 只按轮数判断 |
| `modelChain` | `[]` | 模型优先级链，从已配置提供商 / 模型里排顺序；连续报错达阈值自动切下一个 |
| `modelChainFailures` | `5` | 链上当前模型连续报错几次后切到下一个（1–50） |
| `newSessionDir` | 空 | 新建 QQ 会话放到哪个文件夹（绝对路径，不存在会自动创建）；空 = 「QQ 桥接」工作区。手动归档当前会话后，下一条消息会按这里新建一条 |
| `newSessionModel` | 空 | 新建会话默认模型；空 = 宿主默认模型或 `modelChain` 第一个 |
| `newSessionPreset` | 空 | 新建会话默认预设模式 |
| `pruneBlankSessions` | `true` | 新建 QQ 会话前，把这个文件夹里从没跑过一轮的空白会话归档掉。宿主面板点「新建会话」会优先复用这类空壳，留着它们就会每次打开同一条旧的。归档可撤销 |
| `destinationProfiles` | `[]` | 按 `group:<群号>` / `private:<QQ号>` 分别设休眠时段、24 小时实时回复、连发等待、停听时间 |
| `replyGapMinMs` / `replyGapMaxMs` | `1200` / `2800` | 一轮里分条发出时，两条之间随机间隔的下限 / 上限（毫秒）；写反会自动换过来 |
| `burstWaitMs` | `0` | 对方连着发消息时，先等这么多毫秒没人再说才回复；`0` = 立刻回。每个目的地可单独覆盖 |
| `listenIdleMs` | `120000` | 会话跟随期间，这么久（毫秒）没有新消息就自动停听；默认 2 分钟 |
| `voiceEnabled` | `false` | 要不要发语音。打开后 `[语音]…[/语音]`（以及 `qq_bridge_neko_voice` 工具）才会合成语音；关着时标记原样当文字发 |
| `ttsProvider` | `edge` | 用哪套声音（卡片上是二选一的两块，不是下拉）：本地合成 `edge` = 本机 edge-tts（默认，行为跟以前一样）/ `sherpa` = 本机离线模型；或肥鱼声音服务 `feiyu`（本机 HTTP，要先把服务起起来）。选了哪套就只显示那套的字段，另一套的值不会被清掉。认不出的值直接失败并降级发文字 |
| `ttsVoice` | `zh-CN-XiaoyiNeural` | 音色名（edge / sherpa 用这个；肥鱼用 `feiyuVoice`）。`zh-CN-YunxiNeural` 是男声 |
| `ttsRate` | `-8%` | 语速（edge 用这个；sherpa 走 `ttsSpeed`），edge-tts 写法，`+10%` 更快、`-8%` 更慢 |
| `ttsPitch` | `+12Hz` | 音高（edge 用这个），edge-tts 写法 |
| `ttsPythonPath` | 空 | 跑 edge-tts / sherpa-onnx 的 python 解释器路径（`edge` 与 `sherpa` 用它；肥鱼走 HTTP，不用 python）；留空 = 用 PATH 里的 python |
| `ttsModelDir` | 空 | `sherpa` 的模型目录（要有 `model.onnx`、`tokens.txt` 那些）；留空 = `$DSH_HOME/tts-models/vits-melo-tts-zh_en` |
| `ttsSid` | `0` | `sherpa` 用模型里第几个说话人 |
| `ttsSpeed` | `1` | `sherpa` 的语速倍数，1 = 原速 |
| `voiceMaxChars` | `120` | 单条语音最多多少字，超了就降级发文字 |
| `voiceCacheDir` | 空 | 合成好的音频放哪；留空 = `$DSH_HOME/qq-bridge-neko-voice`。同一句话 + 同一引擎 + 同一组参数只合成一次 |
| `ffmpegPath` | 空 | 转码用的 ffmpeg（肥鱼产的是 wav，发之前尽量转 mp3）；留空 = 先试环境变量 `DSH_TTS_FFMPEG`，再试 PATH 上的 `ffmpeg`。都没有就原样发 wav（不算失败）。包里不内置任何本机绝对路径 |
| `feiyuBaseUrl` | `http://127.0.0.1:9880` | 肥鱼声音服务地址（`ttsProvider = feiyu` 时用）。也支持带一段路径前缀 |
| `feiyuApiKey` | 空 | 肥鱼服务的 Bearer 口令；留空 = 不带鉴权头。只存在本机设置里，日志与文档都不打印它 |
| `feiyuVoice` | `feiyu` | 肥鱼引擎用哪个音色。卡片上是下拉，选项来自服务的 `GET /v1/capabilities`（服务离线时只列内置的 `feiyu`，并注明原因）；存着的值不在清单里会保留成兜底项 |
| `feiyuStyle` | `cute` | 肥鱼引擎的语气：`cute` 软萌 / `gentle` 温柔；认不出回落 `cute` |
| `feiyuTimeoutMs` | `180000` | 肥鱼整体超时（毫秒，含首次加载模型），1000–1800000 |
| `feiyuPollIntervalMs` | `1000` | 轮询肥鱼任务状态的间隔（毫秒），50–60000 |
| `feiyuSingTimeoutMs` | `600000` | 唱歌整体超时（毫秒）。唱歌要走 SVS + RVC + 混音，比说话慢一个量级，10000–3600000 |
| `voiceMaxSongChars` | `400` | 一首歌最多多少唱字（一个音符一个字），1–4000；超了直接拒唱并说明 |
| `feiyuAutoStart` | `true` | 肥鱼服务没起时，插件自己按 `feiyuServerDir` 把它拉起来再合成。关掉后服务没起就直接降级发文字 |
| `feiyuServerDir` | 空 | 肥鱼服务端目录（里面有 `.venv` 与 `configs/voice_service.json`）。自动启动要用它；留空 = 不自动启动 |
| `feiyuPythonPath` | 空 | 跑肥鱼服务的 python。留空 = 服务目录下的 `.venv`（Windows 的 `Scripts\python.exe` / Linux 的 `bin/python`）；找不到就报 `python-missing`，不拿系统 python 乱试 |
| `feiyuIdleStopMinutes` | `10` | 空闲多少分钟自动停服务、释放显存，0–1440；填 `0` = 一直开着。只停插件自己启动的那个进程，别人的服务只发 shutdown |
| `autoStartNapcat` | `false` | DSH 启动后自动拉起**已装好**的 NapCat。只启动，绝不下载 / 安装 / 写配置 |
| `autoStartNapcatDelayMs` | `20000` | 自动启动前的等待毫秒数（0–600000）；填 0 = 起来就立刻尝试 |
| `napcatInstallDir` | 空 | NapCat 安装目录；留空 = `$DSH_HOME/napcat` |
| `napcatWebuiUrl` | 空 | NapCat 网页管理地址；留空 = 读安装目录里的 `webui.json` |
| `checkUpdateOnStart` | `false` | 启动时检查一次有没有新版本（只在日志里提示，不安装） |
| `statePath` | 空 | 状态文件放哪；留空 = `$DSH_HOME/qq-bridge-neko-state.json` |
| `agentPreset` | 空 | resume 目标会话时挂载的 agent preset；留空 = 沿用会话自己记着的 |
| `debugTools` | `true` | 要不要注册 `qq_bridge_neko_status` / `_transport` / `_simulate` 这类排障工具 |

其余键见 [`DESIGN.md`](./DESIGN.md)。

识图服务商、模型优先级链、新会话默认模型与预设、以及每个目的地的个性化，都在设置卡片里用下拉 / 勾选完成：卡片会向 `/api/qq-bridge-neko/catalog`（已配置提供商、各提供商的模型、是否支持识图、预设列表）和 `/api/qq-bridge-neko/profiles`（已接入的群 / 私聊）取清单，不用手抄 id。刚装好、清单还没拉到时，对应下拉会先退化成一个可手填的输入框，拉到之后自动变成选项。两个接口都是只读，准入和设置接口相同。

## 使用

在群里 @ 机器人，或叫出昵称。白名单没填时不会醒。

### 主人改群白名单

整句必须就是命令，前面可以加一个 `/`。多出来的字不当命令。不是主人时按普通聊天处理：不改配置，也没有单独的拒绝回复。还没进白名单的群，主人仍能在群里直接加。调试工具模拟的消息不会改白名单。

| 在哪 | 整句 | 作用 |
|---|---|---|
| 群里 | `白名单 加`、`白名单 加本群` | 把当前群加进群白名单 |
| 群里 | `白名单 删`、`白名单 删本群` | 把当前群移出 |
| 群或私聊 | `白名单 加 群号`、`白名单 删 群号` | 按写明的群号加或删 |
| 群或私聊 | `白名单`、`白名单 列表` | 回复现在有几个群 |
| 私聊 | `白名单 加`（没写群号） | 不改配置，提示要写群号 |

删到一个群都不剩时，回复会说明现在任何群都不会叫醒。保存方式和设置卡片相同。

### 发回群里

`replyMode` 为 `marker` 时，模型把要发到群里的话放进 `[QQ]…[/QQ]`。一轮里可以放多个块，会按顺序一条一条发出去（引用只挂在第一条上），不会再被拼成一条带空行的长消息。

### 发语音

两条路：正文里写 `[语音]要念的台词[/语音]`（需要 `voiceEnabled` 打开，一个语音块发一条，前后文字仍是文字），或者直接调 `qq_bridge_neko_voice` 工具（`text` 只写要念的本体，可用 `voice` / `rate` / `pitch` / `style` 单次覆盖参数，用 `provider` 单次切换引擎，同样要过白名单与来源闸门）。走哪套引擎由 `ttsProvider` 决定（默认 `edge`；选 `feiyu` 前记得先把肥鱼声音服务起起来）。两条路合成失败都会降级成文字并在前面注明「（语音没合成出来）」。

### 唱歌

调 `qq_bridge_neko_sing`，给 `score`（ABC 记谱的单音主旋律）和 `lyrics`（逐字汉字歌词；一个音符一个字，一字多音用 `_`），可选 `transpose` / `bpm` / `pinyin`。要 `voiceEnabled` 打开、`ttsProvider = feiyu`，并且肥鱼声音服务里唱歌引擎（SVS + RVC）已经配好。唱不了时降级发文字并在前面注明「（歌没唱出来）」加原因，不会静默消失。

### 其余工具

`qq_bridge_neko_send`（`replyMode=tool` 时的正式出站通道）、`qq_bridge_neko_listen`（会话跟随）、`qq_bridge_neko_sticker`（表情包收藏 / 发送）、`qq_bridge_neko_napcat`（NapCat 状态 / 下载 / 配置 / 启停）、`qq_bridge_neko_status` / `_transport` / `_simulate`（排障）。会话跟随、戳一戳和出站闸门的完整流程见 [`DESIGN.md`](./DESIGN.md)。

## 更新

设置卡片里先点「检查更新」，有新正式版时点「更新到 vX.Y.Z」。装完会自己重启 dsh-web。设置还在，不改 NapCat。刷新页面后，登录口令可能会变。

**实际每次都走 GitHub。** 更新流程先问一遍 npm，包里这个作用域名在 registry 上不存在（404），于是改用本仓库同一 tag 的源码包：先 `github.com`，连不上再试 `codeload.github.com`。卡片上「在 npm 上」这句在没发布 npm 时不会出现。

「检查更新」和「启动时检查一次」只询问，不会安装。已经是最新正式版时不出现更新按钮。不会装比当前更旧的版本，也不装草稿和预发布。

0.2.12 起，重启后如果 `$DSH_HOME/.agent-presets/dsh-qq-bridge/skills/qq-session-reply-style/references/reply-style.md` 里还有 “Emoji are welcome when they make the answer friendlier.”，会删掉这一句。「Avoid Markdown formatting. Use plain text.」还在，其它行不动，也不另写禁用表情的规矩。这份文件本来没有时不会新建。已经读进当前会话的旧规则，要等下次再读这份说明，或另开一条会话。

## 排障

**`dsh plugin add dsh-qq-bridge-neko@1.1.6` 报找不到包** — 正常的，这个包不在 npm 上。用[安装](#安装)里的两条装法之一。

**设置页里没有卡片** — 先看 `package.json` 的 `dsh.client` 与 `exports["./client"]` 还在不在，然后重启 dsh-web（bundle 只在启动时扫）。仍然没有时调 `qq_bridge_neko_status`，看 `clientHalf` 字段。

**卡片在，但接口 404** — `cordis.patch.yml` 里 `qq-bridge-neko` 的 `name` 和实际安装的包名不一致。改成 `dsh-qq-bridge-neko`（v1.1.5 及更早是 `@fengye_nobug/dsh-qq-bridge-neko`）再重启。

**装上了但谁都不理** — 白名单默认全空，先填 `groupWhitelist` / `whitelist`。再看 `onebotUrl` 是否指向正在跑正向 WebSocket 的 NapCat。

**消息进来了不回** — 看 `qq_bridge_neko_status` 的 `recentLog` / `recentInboundSources`（`ours=false` 说明没认出这条消息的归属）、`gate`（出站闸门）和 `recentDropped`（被拒台账）。

用着有问题，到 [Issues](https://github.com/SmilessNEKO/dsh_qq_onebot_neko/issues/new/choose) 选模板：**连不上**、**不回**、**发不出**。不要在 Issue 里贴真实 QQ 号、群号、token 或服务器地址。

## 发版（本地维护）

本仓库不通过上游 main 发布，也不往 npm 发。一次发版：

1. 改 `package.json` 的 `version`，在 [`CHANGELOG.md`](./CHANGELOG.md) 顶部写这一版；用法或设置项有变动时同一次提交里改这份 `README.md`。
2. 本地 `npm pack` 打出 `.tgz`，`git` 提交并推到本仓库，打 `vX.Y.Z` tag。
3. 在 GitHub 上建 Release，把 `.tgz` 作为资产上传（`.gitignore` 已忽略 `*.tgz`，不入库）。
4. 用上面的 `dsh plugin add` 命令装 `.tgz` 或 `#vX.Y.Z` 验证。

**版本号怎么涨**：每次改动只动最后一位（patch）+1。patch 涨过 9 就进位到中间那位（minor）+1、patch 归 0，中间那位允许是两位数——`1.1.9` 的下一版是 `1.2.0`，`1.9.9` 的下一版是 `1.10.0`，`1.10.9` 的下一版是 `1.11.0`。第一位（major）不自动涨，只有明确要求时才改。

`.github/workflows/npm-publish.yml` 只是**手动**触发的可选通道（`workflow_dispatch`，只在本仓库 `main` 上跑），默认不在 push 时发布。它有 `NPM_TOKEN` 也发布不了这个包——作用域没在 npm 注册过。不用发布就完全别碰它。

## 许可

MIT。详见 [`LICENSE`](./LICENSE)。本插件基于 sj244 的 dsh-qq-bridge（MIT），上游版权保留。
