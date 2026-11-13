# 更新日志

## v1.1.8 — 2026-11-14

- **修好一条一直静默失效的音质滤镜链**。`equalizer` 的 `t=q` 参数是 ffmpeg 5.x 才有的，本机 ffmpeg 是 2016 年的构建（`N-81989-g7845c13`），一进滤镜就报 `Option 't' not found` → `Error opening filters!`；而转码逻辑是「滤镜失败就退一步无滤镜再转」，于是每次都在无滤镜兜底上静默成功——这就是「声音干、不够圆润」的真实原因。改成 `width_type=q` 后整条链（高通 / 低通 / 两段 EQ / 轻压缩 / `loudnorm`）才真的生效。
- **新增音色 / 音高 / 语速三个键（三个引擎通用）**：`voiceTone`（`natural` / `soft` / `warm` / `deep` / `bright`）、`voicePitchSemitones`（半音，-12~12）、`voiceSpeedFactor`（0.5~2）。实现全在插件侧用 ffmpeg 后处理（变调走 `aresample=48000 → asetrate → aresample=48000 → atempo` 补时长），**不动服务端、不动 SHA 绑定的模型包**。带参数时产物派生新文件，原 wav 不重新合成；缓存名带上这三个参数，改了音色不会命中旧缓存。
- **新增语气预设 `voiceMood`**：`default` / `sweet` 撒娇 / `gentle` 温柔 / `lively` 元气 / `serious` 认真 / `sleepy` 困倦。语气是一组参数的打包（肥鱼 style + 音色 + 变调 + 语速），三个单参数填了会覆盖它。肥鱼的 `style` 优先级变成「显式传的 > 语气预设 > `feiyuStyle`」——因为 CosyVoice 只有 cute/gentle 两种 style、服务端协议没有情感字段（改它要动模型包），语气只能在插件侧做组合。
- **sherpa 引擎支持 kokoro 多音色模型**：模型目录里只要有 `voices.bin` 就按 `OfflineTtsKokoroModelConfig` 加载，没有就仍按 `OfflineTtsVitsModelConfig`，换模型不用改配置。默认模型换成 `kokoro-multi-lang-v1_1`（103 个音色、24kHz），`ttsSid` 默认从 0 改成 **41**（`zf_074`，偏清亮的少女音）；旧的 `vits-melo-tts-zh_en` 仍可用（单音色，sid 只有 0）。
- 工具 `qq_bridge_neko_voice` / `qq_bridge_neko_sing` 都加了 `mood` / `tone` / `semitones` / `speed` 单次覆盖参数。
- 设置卡片「声音」页加了语气下拉与三个参数输入；`ttsSid` 标签改成「sherpa 用哪个音色（编号）」并写清 kokoro 的音色分布。
- 自测：`test-voice.mjs` 161 → **197 条全通过**（新增音色常量、滤镜链、缓存名、语气预设、真 ffmpeg 跑链）；`test-smoke.mjs` 698 条、`test-updates.mjs` 113 条同样全通过。
## v1.1.7 — 2026-11-13

- **设置入口搬进 DSH 设置页：撤掉左下角侧栏按钮，改注册 `settings.section`**。以前走的是 `sidebar.footer.action`（侧栏脚部、Settings 上面那个「🐟 QQ 桥接 Neko」），点开是一个居中浮层面板。问题是同一个设置有两套入口、两套视觉，找起来反而更乱。现在改成设置页左侧导航里的一节「QQ 桥接 Neko」，和「内置插件」「Vision Router」并列，点进去就是原来那张卡片（分页、保存、检查更新全不变）。
  - 删掉 `FootEntry` 组件（含 Esc 关闭、点遮罩关闭那套浮层逻辑）与它专用的四个样式（`footEntry` / `footEntryIcon` / `overlay` / `sheet` / `sheetHead` / `sheetTitle`）。
  - 卡片本身一行未改：`Card` 仍是自带标题与折叠的那张，`settings.section` 的 `label` 只用于导航项文字。
  - 插件页那几处入口（`settings.plugins.tab` / `settings.plugin.item` / `plugins.tab` / `plugins.detail.section`）原样保留 —— 老宿主没有 `settings.section` 时仍能找到设置。
- 自测：`test-smoke.mjs` 的 slot 注入断言补上 `settings.section`，五个挂载点数量不变（`sidebar.footer.action` 换成 `settings.section`）；698 条全通过。`test-updates.mjs` 113 条、`test-voice.mjs` 161 条同样全通过。

## v1.1.6 — 2026-11-13

- **包名去掉作用域：`@fengye_nobug/dsh-qq-bridge-neko` → `dsh-qq-bridge-neko`**。改的是 `package.json` 的 `name`，以及所有靠它做模块解析的地方：`cordis.patch.yml` 里 `qq-bridge-neko` 那一行的 `name`、`index.js` 的 `PACKAGE_NAME`、`updates.js` 的 `PACKAGE_NAME`、`client/client.js` 的 `__ModuleLoader__` `id` 与 `exports.name`。
  - `npm pack` 产物文件名跟着变成 `dsh-qq-bridge-neko-1.1.6.tgz`（以前是 `fengye_nobug-dsh-qq-bridge-neko-*.tgz`）。
  - **npm 上两个名字都查不到**（`registry.npmjs.org` 与 `registry.npmmirror.com` 对两个名字都回 404），所以这条改动不影响任何 npm 通道 —— 本来就没有。安装仍旧只走本地 `.tgz` 或 GitHub tag。
- **兼容老安装**。v1.1.5 及更早装的是带作用域的目录 `node_modules/@fengye_nobug/dsh-qq-bridge-neko`。新增导出 `LEGACY_SCOPED_NAME = '@fengye_nobug/dsh-qq-bridge-neko'`：
  - `isWritablePackageName()` 认它，所以升级时 `cordis.patch.yml` 里残留的旧作用域名仍会被改写成磁盘上的实际包名（`rewriteCordisPackageName` / `alignCordisNames`）；
  - `installedMatches()` 与 `alignCordisNames()` 读已安装清单时，两条路径都查（`node_modules/dsh-qq-bridge-neko` 与 `node_modules/@fengye_nobug/dsh-qq-bridge-neko`），老目录照样能升级；`alignCordisNames()` **优先用新目录**的清单（新目录里的 `name` 才是当前包名），否则两个目录并存时会被老目录的旧名字带着把补丁改回去；
  - 下载校验（`repackReleaseTarball` 的 `expected.name` 为空那条分支）也认旧作用域名 —— v1.1.5 及更早的 release 资产里 `name` 还是旧的，从老 tag 升级不会因为名字不匹配被拒；
  - `client/client.js` 的 `bindSettings` 候选命名空间与 `subjectIsOurs()` 也保留旧作用域名，插件详情页对老安装照样认得出自己。
- **设置卡片不用改**：settings 命名空间一直是 `qq-bridge-neko`（Cordis id），跟包名无关，所以已存的设置、state 文件、API 路径全部沿用。
- 自测：`test-updates.mjs` 113 条、`test-smoke.mjs` 698 条、`test-voice.mjs` 161 条，全部通过。测试基线里的「当前包名」跟着改成无作用域名；`plantScoped()` 造的是真实升级场景（磁盘上已是新目录、补丁里还留着旧作用域名），用来钉住 `alignCordisNames` 的改写行为。

## v1.1.5 — 2026-11-13

- **新增 `fallbackToOwnerPrivate`（默认关）：没指定发给谁时，改成发主人私聊**。以前「不传群号也不传私聊号」的出站会沿用最后一次入站消息的目的地，在群里聊完就永远发回那个群 —— 想私聊说话只能每次手动传号，漏一次就发到群里。打开这个开关后，兜底目的地直接取 `ownerWhitelist` 的第一个号（主人 QQ），不带引用段（那条消息不在这个目的地里）。
  - 覆盖三处兜底：`sendToQQ`（工具直发）、`resolveOutboundDest`（marker 块出站）、以及一轮结束时的 marker 发送路径。
  - **显式指定的目的地不受影响**：传了 `groupId` / `userId`、或者这一轮本来就是被 QQ 消息钉住的回复，照旧发到原处。只有「什么都没说」的那条路径会改。
  - `ownerWhitelist` 为空时不硬凑，仍旧回落到最后一次入站目的地 —— 宁可发到聊天的那个群，也不让消息凭空消失。
  - 主人身份只认 `ownerWhitelist[0]`，没有为这个功能另加一个「主人号」设置键，避免两份真相打架。
  - 设置卡片「唤醒」页加了这个开关，说明里写清关掉时的行为。
- 自测：`test-smoke.mjs` 新增 6 条兜底用例（非 QQ 轮先要一次确认，一个字不发；开着 → `send_private_msg` 且没有 reply 段；关着 → `send_group_msg` 到群里且照旧引用最后一条入站；开着但主人号为空 → 回落群里，不丢消息），全部通过。

## v1.1.4 — 2026-11-13

- **肥鱼声音服务改成插件自己管：没起就拉起来，闲下来自己停**。以前服务得人手动开着，忘了关就一直占显存；关了呢，发语音又直接降级成文字，看着像插件坏了。现在合成（说话和唱歌）之前都先探一次 `GET /health`（免鉴权）：
  - 通 → 直接合成；
  - 不通且 `feiyuAutoStart` 开着（默认开）→ 按 `feiyuServerDir` + `feiyuPythonPath` 把服务拉起来，轮询 `/health` 等它通（最多 60 秒），然后再合成；
  - 不通且自动启动关着 → 直接失败并降级发文字，原因里写清「自动启动已关闭」。
  - 新键四个：`feiyuAutoStart`（默认 `true`）、`feiyuServerDir`（空 = 不自动启动）、`feiyuPythonPath`（空 = 用服务目录下的 `.venv`，Windows 找 `Scripts\python.exe`、Linux 找 `bin/python`；找不到就报 `python-missing`，**不拿系统 python 乱试** —— 依赖没装时那种错更难懂）、`feiyuIdleStopMinutes`（默认 10 分钟，0 = 一直开着）。
  - 同一地址并发请求只拉起一次（`entry.starting` 去重），不会两个进程抢同一个端口。
  - 空闲自停：合成成功刷新「最后使用时间」，到点先 `POST /v1/admin/shutdown` 让服务自己走 lifespan 收尾（它自己会校验队列空才退，任务不会丢）；接口不认 / 不通 / 有任务在跑才 kill —— **而且只 kill 插件自己 spawn 的那个进程**。别人手工起的服务只发 shutdown，绝不凭空杀掉。
  - 缓存命中也会刷新计时器（否则整句都命中缓存时，服务会被误判空闲而提前停掉）。
- **服务端新增 `POST /v1/admin/shutdown`**（`feiyu_voice_service/app.py`）：队列不空闲回 `409`，不是通过打包入口起的（拿不到 `uvicorn.Server`）回 `503`，否则置 `should_exit` 让 uvicorn 正常退出并释放显存。为此 `__main__.py` 从一行 `uvicorn.run(...)` 改成显式 `uvicorn.Config` + `uvicorn.Server` + `app.state.server = server`，这样接口才拿得到 Server 对象。
- **音质：转码时过一条轻量滤镜链**。以前是裸转 `-b:a 64k`，听着干、偏薄。现在 wav → mp3 走 `highpass=f=80, lowpass=f=12000, equalizer=f=200:t=q:w=1:g=1.5, equalizer=f=3000:t=q:w=1.5:g=1.5, acompressor=threshold=-18dB:ratio=2.5:attack=10:release=150, loudnorm=I=-16:TP=-1.5:LRA=11`，输出 44.1kHz / 96kbps。两个坑记一下：`loudnorm` 内部会把采样率升到 192kHz，所以**必须显式 `-ar 44100` 收回来**，否则 libmp3lame 编不出来；老版本 ffmpeg 缺某个滤镜时**退一步**用无滤镜参数再转一次 —— 宁可音色差一点，也别因为滤镜不支持就发不出声。
- **去掉硬编码的 ffmpeg 路径**。`voice.js` 里原来写死了 `D:\小丸\tools\ffmpeg.exe`，别人机器上根本没这个位置，「装到别人机器也能用」就是空话。现在只找三处：设置的 `ffmpegPath` → 环境变量 `DSH_TTS_FFMPEG` → PATH 上的 `ffmpeg`；全都没有就原样发 wav（不算合成失败）。
- **修一个会让自动启停完全失效的键名冲突**。设置里那四个键带 `feiyu` 前缀（`pythonPath` 这个无前缀名在 edge / sherpa 分支里已经被 `ttsPythonPath` 占了），`synthesize()` 分派给 `feiyuSynthesize()` 时要把前缀摘掉。第一版写成了「只在无前缀键为空时才用带前缀的」，结果 `index.js` 不管哪个引擎都会把 edge 的 `pythonPath` 一起传下来 → 肥鱼拿着 edge 那个 venv 去起服务 → 找不到 `feiyu_voice_service` 模块，`exit=1`，报的还是「服务起不来」这种看不出根因的错。现在改成**带前缀的键优先覆盖同名无前缀键**，并补了一条回归用例把这个场景钉死（断言 spawn 的 argv[0] 与 cwd 都来自 `feiyuPythonPath` / `feiyuServerDir`）。
- 设置卡片「声音」页新增这四个键（`feiyuAutoStart` 是开关，另外三个是输入框），都归在肥鱼那一套里，切到本地那套会一起收起来。
- 自测：`test-voice.mjs` 新增 12 组共 30 条（滤镜链与输出规格、探活通 / 不通 / 地址非法、自动拉起的 argv 与 cwd 与端口解析、服务活着不 spawn、关掉自动启动 / 没填目录 / 找不到 python 三种原因、并发只拉一次、空闲到点调 shutdown、有活动不被停、别人的服务不 kill、自己拉起的 shutdown 失败才 kill、`feiyuSynthesize` 探活失败不打 POST、探活成功后照常合成），全部通过；假服务统一应答 `GET /health`，测试不碰真服务、不占端口、不真起进程。

## v1.1.3 — 2026-11-13

- **修暗色主题下设置面板白底白字**。v1.1.2 的浮层面板写的是 `background: var(--dsh-bg-elevated, #fff)`，但宿主根本没有 `--dsh-*` 这套变量（它的设计令牌前缀是 `--dsw-`），于是永远回落到写死的 `#fff`；配合 `color: 'inherit'` 从暗色面板继承来的浅色字，就是截图里那块「整片纯白、字几乎看不见」。现在整张卡片的颜色都改走宿主令牌：
  - `TOKEN.surface` = `var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, #ffffff))` —— 面板底、下拉弹层底
  - `TOKEN.field` = `var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1, #ffffff))` —— 输入框底（以前是 `transparent`，暗色下只剩一圈边框）
  - `TOKEN.text` = `var(--dsw-alias-label-primary, #1a1a1a)` / `TOKEN.textSoft` = `var(--dsw-alias-label-secondary, #4a4a4a)`
  - `BORDER` 也换成 `var(--dsw-alias-border-l2, rgba(127,127,127,0.35))`
  宿主这两套值分别定义在 `body{…}`（亮）与 `body[data-ds-dark-theme]{…}`（暗）里，切换主题时跟着变，插件不用自己判断当前是不是暗色。
- **修原生下拉弹层纯白**。`<option>` 不继承 `<select>` 的 `background` / `color`，弹层底色由浏览器 UA 决定，所以即使 select 自己透明，展开仍然是一块白。现在 `client/client.js` 里**全部 22 处** `h('option', …)` 都带上了 `style: OPTION_STYLE`（`{ background: TOKEN.surface, color: TOKEN.text }`），覆盖 `feiyuVoice` 音色下拉、会话 / 群 / 模型 / 预设等所有选择器。
- 顺手把 `S.btn` / `S.header` / `S.miniBtn` / `S.tab` / `S.choiceCard` / `S.footEntry` / `S.link` 里残留的 `color: 'inherit'` 一并换成令牌色，避免以后换宿主主题时某个按钮文字跟着背景一起消失。
- 只动呈现层：`FIELDS`、键名、`format()` / `parse()`、保存逻辑、`index.js`、`voice.js` 全部未改。
- 自测：`test-settings-tabs.mjs` 28 条全通过；`test-feiyu-voice-options.mjs` 因切函数时带不上模块级常量而报 `ReferenceError: OPTION_STYLE is not defined`，在其 prelude 里补上同名常量后 ALL PASS；`test-voice.mjs` ALL PASS。`README.md` 设置卡片小节新增「跟随主题配色」一条。

## v1.1.2 — 2026-11-13

- **设置页不再是一条长龙：按主题分页，顶上点页签切换**。六十多个键平铺成一列，找任何一项都得滚半天。现在分成「连接 / 唤醒 / 会话 / 回复 / 声音 / 看图 / 模型 / NapCat / 关于」九页，每页只渲染属于它的字段。分页只是**呈现层**：`FIELDS` 的结构、键名、`format()` / `parse()`、保存逻辑一行未改，保存仍是整张卡片一起存，切页签不会丢未保存的改动。
  - 归类漏了不会消失：`FIELDS` 里存在但没写进任何一组的键，会自动落进追加的「其他」页 —— 防的是以后加字段忘了登记、于是界面静默少一片。
- **入口挪到左下角侧栏**：走宿主的 `sidebar.footer.action` 座位（`list` 型、可与别人并存）注册了一个「🐟 QQ 桥接 Neko」按钮，位置就在 Settings 上面。点开是一个居中的浮层面板，里面就是这套设置（分类页签 + 当前页字段），Esc 或点遮罩关掉。原来的入口（设置 → 插件 → 插件配置）都还在，只是不用再钻进去找。
  - 为什么不用 `sidebar.settings` 直接顶掉内置设置页：那个座位是 `single`，已经被宿主自己的 ui-settings 占了，抢不到；`footer.action` 是 `list`，加一个入口是安全的（现在那里已经有 Cordis 面板）。
- **声音模块从「三选一下拉」改成「两套二选一」**。以前本地那套（`edge` / `sherpa`）和肥鱼那套的字段全铺在同一页，看着像两个模块各管各的，容易配混。现在「声音」页最上面是两块卡片：**本地合成**（里面再选 `edge` / `sherpa`）与**肥鱼声音服务**。选中哪套就只显示哪套的字段：
  - 本地那套：`ttsVoice` / `ttsRate` / `ttsPitch` / `ttsPythonPath` / `ttsSid` / `ttsSpeed` / `ttsModelDir`
  - 肥鱼那套：`feiyuBaseUrl` / `feiyuApiKey` / `feiyuVoice` / `feiyuStyle` / `feiyuTimeoutMs` / `feiyuPollIntervalMs` / `feiyuSingTimeoutMs` / `voiceMaxSongChars`
  - **收起来只是不渲染，值不会被清空**，切回去原样还在；两套共用的 `voiceEnabled` / `voiceMaxChars` / `voiceCacheDir` / `ffmpegPath` 一直显示。
  - 存储层仍然是**一个键** `ttsProvider`（`edge` / `sherpa` / `feiyu`）。不新开键是有意的：老设置文件里写的就是它，另起一个键会让现有配置静默失效。
- 实现上是新增 `kind: 'voice-module'` 控件与 `renderVoiceModule()`；`client/client.js` 里新增 `GROUPS` / `LOCAL_ONLY_KEYS` / `FEIYU_ONLY_KEYS` / `usesFeiyu()`，主渲染循环只多做两步过滤（不属于当前页的跳过、不属于当前那套的跳过）。`index.js` 与 `voice.js` **完全没动**——这一版纯前端。
- 自测：新增 `test-settings-tabs.mjs`，用假 `window.__ModuleLoader__` + 假 react + 假 ctx 把浏览器半**真跑一遍**（不是源码字符串匹配），覆盖 28 条：每个字段都归类且不重复 / 分类里没有不存在的键 / 页签全渲染 / 当前页只显示自己的字段 / 切页后上一页字段消失 / 两套互斥且共用项留着 / `sherpa` 归在本地那套 / `sidebar.footer.action` 注册了且带 id 与 order / 未点开是按钮、点开是「按钮 + 浮层」且浮层里真的是设置本体。全通过；`test-feiyu-voice-options.mjs`、`test-voice.mjs` 原样全通过。
- `README.md` 设置卡片小节、语音小节与 `ttsProvider` 表格行同步。

## v1.1.1 — 2026-11-13

- **肥鱼音色 `feiyuVoice` 从文本框改成下拉**：以前要自己敲音色 id，敲错就 `422`；现在卡片直接列服务里注册的音色。选项**不是写死的**：`index.js` 新增 `readFeiyuVoiceOptions()`，打肥鱼服务的 `GET /v1/capabilities`（`Authorization: Bearer <feiyuApiKey>`，2 秒超时），把 `tts[]` / `rvc[]` 投影成 `{id, label, kind, styles, available, engine, reason}`；结果挂在既有 `/api/qq-bridge-neko/catalog` 响应的 `feiyuVoices` 上，client 侧新增 `kind: 'feiyu-voice'` 与 `renderFeiyuVoice()` 渲染下拉。标签会带上每个音色支持的语气（`语气 cute / gentle`）、RVC 包标「换声」、`available: false` 标「当前不可用」并把服务给的原因挂在 `title` 上。
  - **服务不在也能用**：连不上 / 口令不对 / 非 2xx / 无 fetch / 地址非法，一律退回内置的 `feiyu` 一项，并在下拉下面写一句原因（`连不上服务（ECONNREFUSED）`、`口令不对（HTTP 401）`、`服务在跑，但没有注册任何音色` 等）——卡片不会变空、不会报错，也不会因为探测失败就把已存的音色清掉。
  - **不静默改配置**：`feiyuVoice` 存着的值若不在当前清单里（服务没开、音色包被删），下拉会保留它并标成「当前值，不在清单里」，人看得见、改得回。
  - 只改呈现层：设置键名、语义、Schema 类型全没动（仍是字符串，默认 `feiyu`），`readSettings()` 与两处 Schema 未改，老设置文件照旧生效；`format()` / `parse()` 走默认字符串分支，无需新增分支。
  - 探测是**每次打开/轮询 catalog 时顺带做的读操作**，2 秒超时，不阻塞其它字段、不写任何状态、原因串里不含口令。
  - 自测：新增 `test-feiyu-voice-options.mjs`，从 `index.js` / `client/client.js` 里**原文切出**这两个函数真跑（宿主半起真 HTTP 假服务），覆盖 离线 / 在线 / 口令错 / 坏地址 / 空注册 / 未知当前值 / 无 catalog 共 24 条断言，全通过。`README.md` 语音小节与设置表同步。
- **修好肥鱼语音必失败（`speech-http-422`）**：`synthesizeWithSettings()` 以前不管哪个引擎都用 `ttsVoice` 当音色名，于是 `ttsProvider = feiyu` 时把 edge 的名字（`zh-CN-XiaoyiNeural`）发给了肥鱼服务，服务端回 `422 Requested voice capability is not installed/configured`，每次都降级发文字。现在按引擎分开取：`feiyu` 用 `feiyuVoice`（默认 `feiyu`），`edge` / `sherpa` 仍用 `ttsVoice`；工具按次传的 `voice` 仍优先。别的引擎的音色名不会再串到肥鱼那边。
- **新增唱歌：`qq_bridge_neko_sing` 工具 + `feiyuSing()`**。给一段 ABC 记谱的单音主旋律（`score`）和逐字汉字歌词（`lyrics`），走肥鱼服务的 `POST /v1/singing`（谱面 → SoulX-Singer 出声 → RVC 换声），把「唱」出来的歌发到 QQ。一个音符一个字，一字多音用 `_`；`transpose` / `bpm` / `pinyin` 可选。**唱歌只有 `feiyu` 这一条路**（SVS 与 RVC 都在那个服务里），`ttsProvider` 不是 `feiyu` 时降级发文字并说明，不会假装唱了。
  - `feiyuSing()` 与 `feiyuSynthesize()` 同形：先传两份（或三份，带拼音时）资源到 `/v1/assets` 换 id，再 `POST /v1/singing` 拿任务号，轮询 `GET /v1/jobs/{id}`，成功后按对端给的 `audio_url`（没有才 `GET /v1/jobs/{id}/audio`）下载，落缓存后由 `ensureRecordAudio()` 转 mp3。失败翻译成可读 `reason`：`empty-score` / `no-lyrics` / `no-cache-dir` / `bad-base-url` / `auth-failed: 401` / `singing-http-N` / `no-job-id` / `job-failed: 原因` / `job-interrupted` / `timeout: Nms` / `connect-failed: …`，**原因串里不含 API key**。
  - 缓存键 = `谱名 + 谱面 sha1 + 歌词 + 拼音`，再拼音色；同一份谱同一份词第二次一个请求都不发，换一句词就是另一首、不会误命中。
  - 新设置项 `feiyuSingTimeoutMs`（默认 `600000` = 10 分钟，10000–3600000）与 `voiceMaxSongChars`（默认 `400`，1–4000）。唱歌比说话慢一个量级（谱面编译 → 分段 SVS → RVC → 混音），所以超时单独一个键，轮询沿用 `feiyuPollIntervalMs`。
  - 歌词超过 `voiceMaxSongChars` 直接 `too-long` 拒唱并说明长度与上限，不偷偷截断；合成失败降级发文字，正文前加「（歌没唱出来）」加原因。两条路都记 `outbox` / `dropped` 台账，`sessionId` 用 `tool:qq_bridge_neko_sing`。
  - `test-voice.mjs` 新增 8 组唱歌用例（参数校验、成功路径含上传次数/鉴权头/提交体/轮询/下载、带拼音、`transpose`/`bpm` 只在给了才写、任务失败、401、超时、缓存命中与换词不命中），全程用假服务真跑 HTTP。`README.md` 唱歌小节、设置表、使用小节同步。
- **语音改成三套引擎，`ttsProvider` 三选一：`edge`（默认）/ `sherpa` / `feiyu`**。这一版把两条各自演进的工作线并成一条：本机 `sherpa-onnx` 离线模型（`ttsModelDir` / `ttsSid` / `ttsSpeed`）与「肥鱼声音服务」（本机 HTTP）现在共用同一个选择键。**不新开键**是有意的——老设置文件里写的是 `ttsProvider: "sherpa"`，另起一个键会让现有设置静默失效。`voice.js` 里 `synthesize(text, {provider, ...})` 按 `provider` 分派，三个实现返回同一形状 `{ok:true,path,cached,converted?} | {ok:false,reason}`：
  - `edge`：本机 edge-tts 子进程（mp3），行为与之前完全一致，脚本一字未改。
  - `sherpa`：本机 `sherpa_onnx` 离线模型（mp3），脚本一字未改；`ttsModelDir` 为空时直接 `sherpa-model-dir-missing`，不乱猜目录。
  - `feiyu`：`POST /v1/speech` 拿任务号 → 轮询 `GET /v1/jobs/{id}`（`queued` / `running` / `success` / `failed` / `interrupted`）→ 成功后下载音频（优先用对端给的 `audio_url`，没有才 `GET /v1/jobs/{id}/audio`）落缓存。
  - 认不出的 `provider` 直接 `unsupported-tts-provider: X` 让调用方降级，不会无声地用别的引擎顶着。
- 新设置项：`ffmpegPath`（默认空）、`feiyuBaseUrl`（默认 `http://127.0.0.1:9880`）、`feiyuApiKey`（空 = 不带 `Authorization: Bearer`）、`feiyuVoice`（默认 `feiyu`）、`feiyuStyle`（默认 `cute`，另一个是 `gentle`）、`feiyuTimeoutMs`（默认 `180000`，首次加载模型要等）、`feiyuPollIntervalMs`（默认 `1000`）。顺带把 `ttsModelDir` / `ttsSid` / `ttsSpeed` 补进 Schema 与设置卡片——这三个键以前只在 `readSettings()` 里读得到，卡片上看不见也改不了。五处（`config` Schema / `BridgeSettings` / `readSettings()` / `legacySettings` 的 base / 设置卡片的 `FIELDS`）一起补齐——上一版就是漏了 `BridgeSettings` 与 `readSettings()` 才出现「界面上填了不生效」，这次不再留同一个洞。
- 老键 `ttsVoice` / `ttsRate` / `ttsPitch` / `ttsPythonPath` 照旧可用，只把说明改成「`edge` / `sherpa` 用这个」。**不动 `ttsProvider` 时行为与以前一模一样**（默认 `edge`）。
- 失败一律降级发文字，不抛不卡死：连不上（`connect-failed`）、口令不对（`auth-failed: 401/403`）、任务失败（`job-failed: 原因`）、被打断（`job-interrupted`）、超时（`timeout: Nms`）、对端非 2xx、没任务号都翻译成可读 `reason`，正文前加「（语音没合成出来）」。原因串里只有状态码与对端给的文字，**不含 API key**。
- 缓存：`voiceCacheName` 把引擎与各自参数一起进哈希（`edge` / `sherpa`：`voice/rate/pitch → .mp3`；`feiyu`：`voice/style → .wav`），三套引擎的产物不会互相撞；命中缓存时一个请求都不发。**注意：哈希多了引擎字段，`edge` 与 `sherpa` 的历史缓存名会失效一次**，同一句话下次会重新合成一遍，之后照旧命中。
- 新增 `ensureRecordAudio()`：肥鱼交出来的是 WAV，装了 ffmpeg 就转一份 mp3（`-codec:a libmp3lame -b:a 64k`，有同名 mp3 直接复用）；`ffmpegPath` 留空时依次试 PATH 上的 `ffmpeg`、本机约定位置，**都没有 / 转码失败都回落原 WAV，不算合成失败**——能发出去总比因为少个转码工具就降级发文字好。转码在 `feiyuSynthesize()` 内部完成，所以 `index.js` 的调用点与 `recordSegment()` 一行没改。
- 工具 `qq_bridge_neko_voice` 增加可选 `provider`（按次切引擎）与 `style`（按次覆盖肥鱼语气），结果里多一个 `provider` 字段说明这次用的哪套；顺手修掉一个老问题：工具以前直接调 `synthesize()` 又不传引擎，于是设置选了 `sherpa` 时工具这条路径仍然走 `edge`，现在它和正文那条路走同一套分派。
- 设置卡片新增一个 `secret` 字段类型给口令用：**不回显已存口令**（快照里有也不写进 DOM），留空 = 不改、重填才覆盖；顺带避免「打开卡片顺手点保存」把存着的口令清掉。
- `test-voice.mjs` 新增一整套肥鱼测试：用 Node 内置 `http` 起**假服务**真跑 HTTP 全流程，覆盖成功（含鉴权头带与不带的两种情况、请求体、轮询真的等了 `running`）、任务 `failed`、`interrupted`、`401`、`500`、没任务号、连不上、超时、缓存命中不重复请求，以及 `ensureRecordAudio` 的回落路径与真 ffmpeg 转码。`README.md` 语音小节与设置表同步。

- **新增设置项 `pruneBlankSessions`（默认开）：新建 QQ 会话前顺手归档同目录的空白会话**。现象是「在面板点某个工作区的『新建会话』，不但没出现新会话，反而跳回刚才那条」。这是宿主的设计而非故障：客户端 `createInWorkspace` 会先在当前工作区里找一条 `blank && cwd === workspace.path && sessionIds.includes(id) && !archived` 的会话，把它的 id 当 `sessionId` 传给 `sessions.create`；宿主 `claim` 见到这条没有 `turn/start` 就走 `reuseLive` / `resume`，根本不 mint 新 id。所以在面板里手开过、又没聊过的空壳会一直挡在前面，每次点新建都拿回同一条。现在插件在 `createDestSession` 建新会话**之前**（此时新会话还没进工作区，不会被自己归档）调 `pruneBlankSessions(cwd)`：只碰 `workspaceRegistry.resolveByPath(目录).sessionIds`（`resolve` 只查不建，避免顺手新建工作区），只归档没有 `turn/start` 的，跳过已归档的、`sessionByDest` 还指着的、`agents.get(id).status` 是 `running`/`stopping` 的；归档不传 `stopActivity`，正在跑的由宿主抛 `WorkspaceActiveSessionError`、catch 掉跳过，绝不打断谁正在打的字。每轮最多 20 条，清掉后记一条 `prune-blank` 台账，归档可在面板里取消恢复。任何一步失败都只打日志、不挡新建。
- 新增导出纯函数 `blankSessionVerdict(facts)`：判据与宿主一致（`blank = state.blank && event.type !== 'turn/start'`，只有 `turn/start` 会让会话脱离空白），`events` 拿不到时回落投影里的 `sessionListMetadata.blank`，两者都没有就判「不是空白」——宁可少归档，也不碰正在用的会话。`README.md` 会话小节、`pruneBlankSessions` 表格行与 `DESIGN.md` 两处设置表同步。
- **修好「手动归档 QQ 会话后不再新建会话」**：此前插件只会在轮数 / 上下文压力达标时轮换，或在 `resume` 抛错时兜底新建；你在面板里归档当前会话后，`sessionByDest` 仍指着那条已归档的 id，于是每条消息继续投给一条宿主已经拒收的会话（宿主 `agent/pre-step` 对归档会话直接 `reject`，不抛异常），那一轮静默消失、台账里连 `wake-failed` 都不记。现在每次唤醒前先读 `workspaceRegistry.archivedSessionIds`，命中就清掉 `sessionByDest` 并按 `newSessionDir` / `newSessionModel` / `newSessionPreset` 新建一条接着聊。判据只看归档清单（归档不删会话文件，id 会一直留在清单里），读不到清单时 fail-open、不换会话。`sessionScope = single` 下目标会话由 `targetSessionId` 指定，不自作主张换，改为抛错让台账记一条带原因的 `wake-failed`。
- **修好「新建 QQ 会话挂不进工作区」**：`attachToQQWorkspace` 一直用 `ctx.get('workspace')` 取服务，而宿主没有这个服务名（正确名是 `workspaceRegistry`），取到的永远是 `undefined`，函数在第一个 `if` 就静默返回——从没有任何 QQ 会话被挂进工作区，也没有日志。现改读 `workspaceRegistry`；`newSessionDir` 填了目录时工作区标题取该目录名，留空沿用「QQ 桥接」；目录不是绝对路径只记 warn、不抛。
- **新建会话前补建目录**：宿主建会话只校验 `cwd` 是绝对路径、不会替你 `mkdir`，而 `workspaceRegistry.create` 会 `realpath` + `stat` 校验目录存在——配了一个还不存在的 `newSessionDir` 时，会话能建、工作区挂不上。现在 `createDestSession` 先 `ensureDirectory(cwd)`（ENOENT 才递归创建，已存在不碰），再把同一个 `cwd` 传给 `agents.create` 的 `meta.cwd`。
- 新增导出纯函数 `sessionReplacedVerdict(facts)`（会话要不要换掉）与内部 `archivedSessionIds()` / `isArchivedSession()`；`README.md` 会话小节与 `newSessionDir` 表格行同步补上「归档后自动新建」「目录不存在会自动创建」。

## 未发布（仅文档）

- **纠正 README 里的 npm 说法**：`@fengye_nobug/dsh-qq-bridge-neko` 从来没发布到 npm——`@fengye_nobug` 作用域没在 registry 注册过，`npm view` 与 `GET registry.npmjs.org/@fengye_nobug%2Fdsh-qq-bridge-neko` 都是 404（实测）。README 现在开头就写清「这个插件不发 npm」，安装只给本地 `.tgz` 与 GitHub tag 两条，并补了前置条件、NapCat 三步接通、装完为什么必须重启、包名与 Cordis `name` 的对应关系、与旧插件并存要注意的 `onebotUrl`、以及一节排障。`DESIGN.md` 的「用 npm 安装」改成「包名与安装」，同时修掉几处会让人照着执行却必然失败的 `dsh plugin add @fengye_nobug/dsh-qq-bridge-neko@0.2.5`；「不要和官方插件一起挂」改成「不要和上游插件同时连一个 OneBot」（上游 id 是 `qq-bridge`，本 fork 是 `qq-bridge-neko`，两者可并存，抢的只是同一条 WS）。`docs/awesome-dsh-plugin-entry.yml` 与 `HANDOVER.md` 的市场条目路径同步改成 `SmilessNEKO/dsh_qq_onebot_neko`，并注明不写 npm 字段。

## v1.1.0 — 2026-11-12

- **修好一类「设置写不进去 / 读不到」的漏键**：`BridgeSettings`（设置接口的白名单，`knownSettingKeys()` 只认它里面的键）此前没有 8 个语音键，`readSettings()` 也没有输出这些键 → 界面上填了 `voiceEnabled` 等值会被直接丢掉、`s.voiceEnabled` 恒为 `undefined`，语音分支永远不触发。现已在 `BridgeSettings` / `readSettings()` / `legacySettings` 的 base 里全部补齐。同一个洞还漏了 `alwaysWakePrivate`（Schema 里有、`readSettings()` 没输出，导致关掉也不生效），一并补上。
- **可以发语音了**：新增 `voice.js`（纯函数 + edge-tts 子进程，零依赖）。正文里写 `[语音]要念的台词[/语音]`，`voiceEnabled` 打开时这句会合成为 mp3、以 OneBot `record` 段发出去；一个语音块 = 一条 QQ 消息，前后文字照旧分条发，引用只挂第一条。新增工具 `qq_bridge_neko_voice`（显式合成并发送一条语音，走与 `qq_bridge_neko_send` 相同的白名单与来源闸门）。
  - 设置项：`voiceEnabled`（默认 `false`）、`ttsProvider`（默认 `edge`）、`ttsVoice`（默认 `zh-CN-XiaoyiNeural`）、`ttsRate`（默认 `-8%`）、`ttsPitch`（默认 `+12Hz`）、`ttsPythonPath`（空 = 用 PATH 里的 python）、`voiceMaxChars`（默认 `120`）、`voiceCacheDir`（空 = `$DSH_HOME/qq-bridge-neko-voice`）。
  - 合成失败、超长、TTS 不可用时**降级发文字**，正文前加「（语音没合成出来）」，不会整条消失。同一句 + 同一组音色参数命中缓存，不再重复合成。
  - 合成文本走环境变量传给 python（`DSH_TTS_TEXT` 等），避开 Windows 命令行编码问题；record 段用 `file:///` 本地路径而不是 base64（实测两者 NapCat 都吃，本地路径帧更小）。
  - `test-voice.mjs` 覆盖切块、缓存名、record 段与合成失败路径；设 `DSH_TTS_TEST_PYTHON` 时真跑一次合成并验证缓存命中。

## v1.0.0 — 2026-11-12

- **独立发行版**：把原 fork 从 `@fengye_nobug/dsh-qq-bot` / Cordis id `qq-bridge` 整体改成独立身份：npm 包名 `@fengye_nobug/dsh-qq-bridge-neko`、Cordis id 与 settings 命名空间 `qq-bridge-neko`、接口 `/api/qq-bridge-neko/...`、工具 `qq_bridge_neko_*`、状态文件 `qq-bridge-neko-*.json`，设置页显示名改为「QQ 桥接 Neko」。可与旧插件并存在同一 profile，宿主不再按 id 去重把新代码盖掉。
- **发版方式**：改成本地 `npm pack` + 上传到本仓库（`SmilessNEKO/dsh_qq_onebot_neko`）GitHub Release，不通过上游 main、不依赖 npm registry。更新检查仓库、安装命令、Cordis 对齐、npm 包名全部指向新身份；npm 自动发布工作流改为仅手动触发。
- **其它**：`.gitignore` 补 4 个新状态文件名并忽略 `*.tgz`；修好冒烟测试里一个 Windows 路径分隔符断言。上游 sj244/dsh-qq-bridge 的 MIT 版权与许可声明保留在 `LICENSE`。

## v0.2.14 — 2026-11-12

- **DSH 启动后延迟自动拉起 NapCat**：新增 `autoStartNapcat`（默认 `false`）与 `autoStartNapcatDelayMs`（默认 `20000`，即 20 秒，范围 0–600000）。开关打开后，插件在 `apply()` 结束时排一个 `setTimeout`（`unref()`，不拖住进程退出），到点再读一次设置：开关仍开、NapCat 没在跑、且安装目录里已有官方 launcher / 引导器时，走与手动 `launch` 完全相同的 `napcatLaunch()` 启动**已经装好的** NapCat；等待期间用户关了开关、插件被卸载（effect 清掉 timer）、或 NapCat 已在运行，都会跳过。启动失败只记一条日志，不中断插件。
- **只启动，绝不自动下载 / 安装 / 写配置**：`qq_bridge_neko_napcat` 的 `download` / `configure` 仍是显式调用；`napcatStatus` 新增 `autoStart`（`enabled` / `delayMs` / `pending`）便于在卡片上看到排程状态。同步修正 `index.js` / `napcat.js` / `cordis.patch.yml` / `README.md` / `DESIGN.md` 里「插件从不自动执行任何内容」这类随新开关过时的措辞。
- 冒烟测试补 `normalizeAutoStartDelayMs` 纯函数、源码级「只走 napcatLaunch」断言，以及离线假 ctx 真跑 `apply()` 的功能测试（开关打开真的 spawn 一次、关开关 / 卸载不 spawn、默认关不排程）。

## v0.2.13 — 2026-11-12

- **识图服务商改成下拉选择，不用手写模型名**：新增 `visionMode`（`auto` 自动找支持图片输入的模型 / `session` 用会话当前模型 / `fixed` 指定一个，默认 `auto`）、`visionProvider`、`visionProviderModel`。选 `fixed` 时两段联动下拉，从 DSH 已配置的提供商里选一个、再选它下面的模型，模型清单带「支持识图」标记；卡片向只读的 `/api/qq-bridge-neko/catalog` 取清单。旧的 `visionModel`（`provider/model`）只作为没配新选项时的兜底，卡片上不再给输入框。`imageDescribeSafeBytes` / `imageDescribeMaxBytes` / `imageWakeTotalBytes` 仍是只为兼容旧配置保留的空键。
- **每个群 / 私聊可独立个性化**：新增 `destinationProfiles`（数组，按 `group:<群号>` / `private:<QQ号>`）。每条可设 `quietHours` 休眠时段（如 `23:00-08:00`，期间只记账不回复）、`alwaysReply`（给主人私聊打开 = 24 小时实时回复、不受休眠约束）、`burstWaitMs` 连发等待、`idlePauseMs` 停听时间。卡片里可从只读的 `/api/qq-bridge-neko/profiles` 列出的已接入目的地直接挑，不用背群号；后写的同 target 条目覆盖先写的。
- **连发等待与空闲停听**：全局 `burstWaitMs`（默认 `0` = 立刻回）让对方连着发消息时先攒着、停手这么久才回复；每个目的地可在档案里单独覆盖。`listenIdleMs`（默认 `120000` = 2 分钟，下限 10 秒、上限 24 小时）让会话跟随窗口在这么久没有新消息后自动失效、等下一条消息再续，不会一直挂着烧 token。分条间隔改成可调：`replyGapMinMs` / `replyGapMaxMs`（默认 `1200` / `2800` 毫秒，写反会自动换过来），不再写死 1.2–2.8 秒。
- **模型优先级链**：新增 `modelChain`（从已配置提供商 / 模型里排的一串顺序，最多 8 条）与 `modelChainFailures`（默认 `5`，1–50）。`turn/end` 里连续报错 / blocked 达阈值就按顺序切到下一个模型、循环回绕，切换走宿主 `agent.model.select`（不重建会话），成功后清零计数；切换会记一条 `model-chain` 日志，`qq_bridge_neko_status` 里能看到链的实时位置。卡片里同样用下拉排顺序。
- **新建会话可指定落点**：`newSessionDir`（文件夹绝对路径，空 = 「QQ 桥接」工作区）、`newSessionModel`（默认模型，空 = 宿主默认或 `modelChain` 第一个）、`newSessionPreset`（默认预设模式）都能在卡片里选；预设与原 `agentPreset` 一起改成下拉。
- **修一处归属残留**：QQ 唤醒投递失败回滚闸门时，一并回滚 / 清掉投递前落盘的 `state.pendingReplies[wakeSessionId]`，否则下一条非 QQ 轮会被误判成 QQ 轮、把正文误发进群。
- 设置卡片补齐 `rotateEnabled` / `rotateMaxTurns` / `rotatePressureRatio` 三项（之前只能在安装配置里写）。`README.md` / `DESIGN.md` 同步补上新键的键名、默认值、效果与界面行为；冒烟测试（`test-smoke.mjs`）补齐新纯函数与卡片一致性断言。

## v0.2.12 — 2026-11-02

- **QQ 回复风格不再鼓励使用 emoji**：`$DSH_HOME/.agent-presets/dsh-qq-bridge/skills/qq-session-reply-style/references/reply-style.md` 若还写着 “Emoji are welcome when they make the answer friendlier.”，插件启动时删掉这一句。「Avoid Markdown formatting. Use plain text.」以及前后其它行保持原样。不另加「默认不要带表情」或「少用某个表情」的规矩。这份文件不在插件目录里，DSH 升级时也不会改写 `.agent-presets`；它是人设安装时复制进去的。面板更新并重启后才会改到磁盘上的那一份。文件本来就不存在时不会新建，也不用删掉整个人设目录。用法说明和 `qq_bridge_neko_send` 的说明不动。

## v0.2.11 — 2026-11-02

- **轮数上限会用到人设里的压缩**：`maxRecentTurns`（默认 40，填 0 不限制）在 QQ 叫醒的一轮结束并空闲后，压缩更早的内容。标准人设把压缩放在隔离域里，插件所在的宿主上下文看不见，所以 0.2.9 这次调用直接跳过，会话会一直变长，日志里也没有压缩记录。现在先向这条会话的人设要压缩服务，没有再看会话作用域和宿主。已经超限却找不到，或这次压缩没有改动会话时，记一条警告。仍然等这一轮空闲，并带上未取消的取消信号。不必在宿主配置里再打开压缩。哪一层都没有压缩时不影响收发。

## v0.2.10 — 2026-11-02

- **用法说明和发消息工具不再用具体表情名当例子**：注入的用法说明，以及 `qq_bridge_neko_send` 的工具说明和参数说明，不再把笑哭、挥手写成推荐写法。模型之前会抓住这两个例子反复使用。现在只说明半角方括号里写 `[表情名]` 或 `[表情数字]`。对得上的表情名仍会变成 QQ 系统表情，名字表还在 `faces.js`。认不出的方括号仍留在文字里。

## v0.2.9 — 2026-11-02

- **每个会话的轮数上限会真正压缩**：`maxRecentTurns`（默认 40，填 0 不限制）在 QQ 叫醒的一轮结束后，会请宿主把更早的内容压掉。以前这次调用少传了宿主要求的取消信号，压缩还没开始就失败，失败只留在日志里，会话仍会一直变长。现在会等这一轮结束并空闲下来，再按宿主的参数去压缩。宿主没有压缩能力时仍然跳过，不影响收发。

## 0.2.8

- 设置卡片：群白名单在连上 NapCat 时可显示群名和头像；查不到时仍只显示群号
- 设置卡片：新增「主人 QQ」（`ownerWhitelist`）；留空则 QQ 侧白名单指令不生效
- 主人 QQ 指令：`白名单 加/删/列表`（需先配置主人 QQ）


## v0.2.7 — 2026-10-31

- **一键更新装完会自己重启 dsh-web**：安装成功后按面板原来的办法重启，不再把「请自己重启」当成正常结果。Linux 上如果是 systemd 拉起来的，会读本进程的 cgroup，大约 3 秒后只重启认出来的那个服务。服务在用户实例里时用 `systemctl --user`，不会重启整个登录。以前没把 cgroup 读进来，服务里一点更新就直接说面板没有重启。`systemd-run` 没权限或失败时，改为按当前的 node 命令行再拉起一次。两条都做不到，才用白话请你自己重启 dsh-web，并提醒刷新页面、登录口令可能会变。安装超过三分钟、但磁盘上已经是要装的版本时，同样会改包名并重启。进程还在，或没有确认装上时，仍然不会重启。
- **检查和安装的提示改成短句**：设置卡片不再把「优先从 npm…三分钟…」那段长说明当作主要提示。检查按钮旁边写「只检查，不安装。」有更新按钮时另写「装完会重启面板。请刷新；登录口令可能会变。不改 NapCat。」检查结果是「有新版本 x.y.z（现在是 a.b.c），在 npm 上。这里只检查，还没安装。」或「在 GitHub 上」。安装成功是「已经从 npm 装上 vX.Y.Z，面板即将重启。」或「已经从 GitHub 装上 vX.Y.Z，面板即将重启。」自动重启失败时才请自己重启，并写明这次是从 npm 还是从 GitHub 装上的。
- **发版改为推 main**：改 `package.json` 的 `version` 并推到 `main` 后，Actions 在 npm 上还没有 `@fengye_nobug/dsh-qq-bridge-neko` 的这一版时才 `npm publish`，并补 tag `vX.Y.Z` 和 GitHub Release。同一版本已在 registry 里则跳过。`NPM_TOKEN` 放在仓库 Actions Secrets，不写进仓库。

## v0.2.6 — 2026-10-30

- **一键更新之后，Cordis 按实际装上的包名挂 `qq-bridge-neko`**：npm 包是 `@fengye_nobug/dsh-qq-bridge-neko`。v0.2.5 自带的 `cordis.patch.yml` 仍写 `name: dsh-qq-bridge-neko`。Cordis 按这个名字去加载，无作用域包并不存在，插件 id `qq-bridge-neko` 不会挂上，`/api/qq-bridge-neko/settings` 就是 HTTP 404，设置页显示本机接口不可用。现在插件自带的补丁把 `name` 写成 `@fengye_nobug/dsh-qq-bridge-neko`。安装成功后，还会看 profile 的 `cordis.patch.yml`、`$DSH_HOME/cordis.patch.yml`（这份文件里有 `qq-bridge-neko` 才改），以及已经装进 profile 的插件补丁。这三处里 `qq-bridge-neko` 的 `name` 如果还是 `dsh-qq-bridge-neko` 或 `dsh-qq-bridge`，就改成磁盘上 `package.json` 的包名。别的插件不动，`config` 里的设置不动。界面显示名和消息来源仍是 `dsh-qq-bridge-neko`，Cordis id 仍是 `qq-bridge-neko`。从 0.2.5 点「更新」时，跑的仍是 0.2.5 里的安装程序，profile 里手写的旧 `name` 要先改成 `@fengye_nobug/dsh-qq-bridge-neko` 再重启；这一版自己跑一键更新时会改。
- **一键更新卡住时会停掉安装进程**：`dsh plugin add` 或它拉起的 `pnpm add` 超过三分钟没有结束，会停掉这一组进程，并用白话说明，不带路径和堆栈。profile 里的 `.plugin-manager/run.json` 只在记录的进程已经不在、或记录读不懂时删掉；进程还在就不删，也不会再开第二个安装。超时之后如果磁盘上已经是这次要装的版本，仍把 `qq-bridge-neko` 的 `name` 改成实际包名，但不会自动重启，需要自己重启 dsh-web，设置页才会出来。没有确认装上时，可以再点一次「更新」。

## v0.2.5 — 2026-10-30

- **设置卡片可以一键更新**：有新正式版时出现「更新到 vX.Y.Z」。点下去才安装，并重启面板。优先执行 `dsh plugin --profile web add @fengye_nobug/dsh-qq-bridge-neko@版本`，走本机 npm / pnpm 已经配置的 registry。插件不写死镜像地址。registry 里找不到这个版本时，改从 GitHub 下载官方源码包（先 github.com，连不上再试同一标签的 codeload.github.com），不走第三方镜像。v0.2.3 及更早标签里的 `package.json` 仍是无作用域名，这种源码包仍然能装。装完提示刷新页面，登录口令可能会变。现有设置还在，不改 NapCat。已经是最新时没有这个按钮。不会安装更旧的版本，也不装草稿和预发布。连不上、安装失败、没能重启，都用白话说明。
- **「检查更新」和「启动时检查一次」仍然只询问**：不下载、不安装。先问 npm 上的 `@fengye_nobug/dsh-qq-bridge-neko`。有比当前新的正式版时不再访问 GitHub。npm 上没有更新，或包还连不上时，才看 GitHub Releases。
- **npm 包名改为 `@fengye_nobug/dsh-qq-bridge-neko`**：无作用域的 `dsh-qq-bridge-neko` 发不出去，npm 认为它和已有的 `dsh-qqbot` 太像。npm 上已经发出的是 `@fengye_nobug/dsh-qq-bridge-neko@0.2.4`。源码 0.2.5 还没发到 npm，GitHub Release 仍是 v0.2.3。界面显示名和消息来源 `plugin:dsh-qq-bridge-neko` 不变，Cordis id 仍是 `qq-bridge-neko`。不要再用 `dsh plugin add dsh-qq-bridge-neko@版本`。

## v0.2.4 — 2026-10-30

- **设置页可以检查 GitHub 上有没有新版本**：卡片显示当前版本。点「检查更新」才请求 `SmilessNEKO/dsh_qq_onebot_neko` 的 Releases，按 semver 对比。有新版时写出最新版本号、说明摘要，以及 `github:SmilessNEKO/dsh_qq_onebot_neko#vX.Y.Z` 的安装命令。没有新版、连不上、被限流，都用白话说明，不把英文报错摆到界面上。不会自动下载或安装。
- **新设置「启动时检查一次」**（`checkUpdateOnStart`，默认 `false`）：打开并保存后，下次启动 dsh-web 向 GitHub 问一次，只写日志。默认关。
- **安装说明**：README 写清推荐用 Release tag（已发布的是 `v0.2.3`）、Watch Releases、最低环境、白名单先填再 @、三条升级路径（面板升级 / `#vX.Y.Z` / 重装后重启 dsh-web）、与官方 `sj244/dsh-qq-bridge` 不能同时挂同一个 OneBot，以及以后的发版流程（改版本号 → CHANGELOG → tag `vX.Y.Z` → GitHub Release）。
- **npm 与插件市场**：`package.json` 补了 `publishConfig.access`（`public`）和 `engines.node`（`>=22`），`files` 白名单含更新检查模块和 CHANGELOG。维护者用 `npm login` 后自己 `npm publish`，本仓库不代发。当时写的安装命令是无作用域的 `dsh-qq-bridge-neko@<版本>`。这个名字发不出去，实际包名和命令见 v0.2.5。本 fork 还没进 awesome-dsh-plugin，申请步骤和 Issue 模板（连不上 / 不回 / 发不出）写在 README。

## v0.2.3 — 2026-10-30

- **商城表情按原生表情包发出去，普通图片仍是图片**：入站 `mface`，以及带着 `emoji_id` / `emoji_package_id` / `key` / `summary` 的 `image` 段，会把这四项跟图片哈希留在一起。图片落盘时旁边写 `<hash>.mface.json`。`qq_bridge_neko_sticker` 的 `save` 把它们抄进登记表。`send` 时四项都在就发 OneBot `mface`（`emoji_package_id` 是数字）；缺任何一项仍用 `base64://` 发图片。模型看到的占位符也分开：商城表情是 `[表情包#短哈希]`，普通图片是 `[图片#短哈希]`。没有可下载图片的 `mface` 只有文字占位符，登记不了。没有这些 id 的图（本地图、收藏表情、普通图片）发出去仍是图片。

## v0.2.2 — 2026-10-30

- **出站把 `[笑哭]` 这类表情名变成系统表情**：`sendToQQ` 在去掉 Markdown 之后，把正文拆成 OneBot 消息段。`[笑哭]` 是 face 182，`[挥手]` 是 face 129，NapCat 显示系统表情。也认入站占位符 `[表情182]` 和 `[CQ:face,id=182]`。对不上的方括号留在文字段里。标记块和 `qq_bridge_neko_send` 都走这条路。`qq_bridge_neko_sticker` 继续按登记表发送图片。字数上限按拆表情之前的正文计算。

## v0.2.1 — 2026-10-30

- **设置接口不再因为没注入 webServer 而变成空的 HTTP 400**：已登录的面板请求会问监听器是不是 HTTPS。以前读 `ctx.webServer`，插件并没有 inject 这项服务，Cordis 直接抛错，宿主收成没有正文的 400，卡片诊断显示本机接口不可用。现在只通过 `ctx.get('webServer')` 读协议。读不到这项服务、或读取失败时，按 HTTP 继续做登录判定。
- **按群新建的会话带工作目录和标题**：以前新建会话不带 `meta.cwd`，会话落在 `_no-cwd`，面板打开报 `session/not-found`，轨迹是空的。标题只写在日志里，列表显示「未命名」。现在工作目录优先用宿主 `workingDirectory.defaultDirectory`，没有这项或它不是绝对路径时，用进程当前工作目录。标题写成「QQ群 <群名或群号>」或「QQ私聊 <昵称或 QQ 号>」：先走宿主的会话改名，改名服务不可用或失败时，直接写入 `session/title`。升级前已经建好、当时没有工作目录的旧会话不会自动改。删掉状态文件里对应的 `sessionByDest`，再在那个群或私聊里 @ 一次，才会按新规则新建。

## v0.2.0 — 2026-10-30

Fork 功能版本。Cordis 插件 id 仍是 `qq-bridge-neko`。

- **设置卡片不等宿主设置服务**：DSH 0.2.x 上 `settingsScope` / `webUiSettings` 可能不存在，以前会一直等、卡片不出现。现在加载时就挂到设置页和插件页（含插件详情，只挂在本包上）。宿主设置域还在就用它，否则走 `/api/qq-bridge-neko/settings`。请求带上面板登录 cookie。卡片默认展开。
- **NapCat 网页地址和缺失目录**：新增设置 `napcatWebuiUrl`（「NapCat 网页管理地址」）。留空仍读 `webui.json`；地址是 `127.0.0.1` 或 `localhost` 时，「打开 WebUI」保持可点，并说明只有跑着 NapCat 的机器能打开。安装目录不存在时「打开文件夹」不会去猜路径，提示自己部署或 Docker 要另填目录。NapCat 已经自己跑着时，可以跳过下载那一段，但 OneBot 端口仍要对上。
- **设置卡片改成白话**：标签、说明和选项都是中文，例如「群里发出去的是哪一段」「忙的时候怎么插话」。配置键仍是英文。
- **设置和 NapCat 按钮不再只限本机回环**：本机请求照旧可用。经反向代理访问时，认 DSH 面板已经通过的登录会话，不必再配 `trustedHosts`。没有会话的外网请求仍然拒绝。打到 `127.0.0.1`、但来源是别的网站的请求也仍然拒绝。
- **出站目的地钉在唤醒那一轮**：标记块、发消息工具、表情包和会话跟随都用这一轮被叫醒时的群或私聊。别的群里只被记录的消息仍会更新“最后一次入站”，但不会把正在回答的这一轮带跑。工具里显式写了群号或 QQ 号时发到那里，并且不引用别的会话的原消息。
- **按目的地分会话，并限制每个会话保留的轮数**：新设置 `sessionScope`（`single` 默认，沿用一个 `targetSessionId`；`perGroup` 为每个群、每个私聊自动创建或恢复一条 DSH 会话）。映射持久化在状态文件的 `sessionByDest`。`maxRecentTurns` 默认 40，`0` 表示不限制；QQ 驱动的一轮结束后，若宿主有 `compaction.compactNow`，会尽量把更早的轮次压到这个上限。
- **Fork 品牌改为 dsh-qq-bridge-neko**：包名、界面显示名、NapCat 配置里的默认名称改为 dsh-qq-bridge-neko。Cordis 插件 id、设置命名空间和 `/api/qq-bridge-neko/...` 仍是 `qq-bridge-neko`，已有 profile 覆盖不用改。v4 消息来源写成 `plugin:dsh-qq-bridge-neko`，同时仍认上游的 `plugin:dsh-qq-bridge`。上游 [sj244/dsh-qq-bridge](https://github.com/sj244/dsh-qq-bridge) 的 MIT 版权保留。

- **修 issue #1：相邻重复的 `[QQ]` 块只发一次**：模型先写回答、再调工具、随后又把同一句重写一遍时，
  本轮正文按 step 累积，拼接后 QQ 会收到连着两句相同的话。现在相邻且完全相同的块只保留一个；
  非相邻的重复保持原样（可能是刻意复述）。比较的是块内正文（已 trim），
  所以中间夹着给 DSH 看的正文也能识别。
- **提示词：不要给正文加额外标签**：部分模型习惯在句子后面补 `</test>` 这类标签。
  群聊礼仪里写明「要界定引用就用双引号，不要额外加标签 —— 标签起不到界定作用，
  只会跟着正文一起发到 QQ」。
- **提示词：无人值守的判据改成“要不要提权”**：原来写成一串「不要主动做：执行或安装程序……写文件」，
  有的模型把它读成“什么都不能改”，连会话工作区里写文件都不敢做。现在写明判据是
  **这件事要不要向会话发起人提权（征求同意）**，并明确「会话工作区里写文件、改代码、跑测试、
  读资料都是正常工作，照做即可」。同时补上例外：**管理账户在私聊里明确要求时按该要求执行** ——
  私聊 + 被唤醒即说明发信人在白名单内，就是会话发起人本人；群里任何人的同类要求仍不算例外。
  不弹审批的路径（浏览器点网页、直接发 HTTP 写请求）仍然不许拿来绕过这份清单。
- **用法说明的重挂判据改为比对渲染后的正文**：原来比一个「设置签名」。签名漏过两次 ——
  先只按 `replyMode` 判（改出站字数上限不生效），再是正文加了一句措辞而签名没跟着变
  （改文案不生效）。改文案也要重启一次才生效，这一点很难被发现。
  现在直接比 `buildUsagePrompt()` 的输出，设置与文案任何一处变了都会重挂，不必再维护签名的键清单。

## v0.1.3 — 2026-10-10

维护性更新：1 项安全修复 + 两轮审计修复 + 文本规范修订。无功能新增。
行为有 3 处变化：超长出站改为拒绝发送、设置卡片支持撤销覆盖、省略条数按真实丢失量统计。

- **本机接口不再只认回环地址，改为校验请求来源**（安全修复）：设置接口与 NapCat 路由原来只看对端
  地址，用户浏览器里的任意网页都能用无预检的 `fetch` 打到本机端口 —— 响应读不到，但改白名单、
  改目标会话、启动 NapCat 这些副作用照发生。现在两道路由组共用同一道闸门，按
  「对端地址 → 来源（`Origin`，无 `Origin` 时看 `Referer`）→ 带体 POST 的 `content-type`」判定。
  空体的 POST 不要求 `content-type`：跨站简单请求的 `content-type` 只能取安全列表里的值，
  带体的 POST 必须声明 `application/json`；空体改不了任何东西，且来源判定对所有请求都生效。
  卡片发出的 POST 已补上 JSON 头。原来直接显示在卡片上的英文错误码一并改成中文。
- **用法说明的重挂判据改为设置签名**：原来只看 `replyMode`。改「出站字数上限」后常驻提示仍写旧值，
  模型按旧上限写字，出站一律按 `too-long` 丢弃，QQ 里没有消息且模型不知道。
  现在判据是提示词所依赖设置（`replyMode` 与 `replyMaxChars`）的签名。
- **目标会话被卸载后不再复用死句柄**：命中缓存句柄时按对象同一性验活，失效就删条目并走 `resume`。
- **出站被拒时新增独立丢弃台账并回注会话**：标记块被拒（超长、未连接、无目的地）原来只写日志，
  模型以为已经回复。现在记入 `state.dropped`（环形上限 20 条），并在 `qq_bridge_neko_status` 的
  `recentDropped` 暴露；同时用 `agent.inject()` 把原因回注会话 —— 只进上下文、不唤醒，
  避免模型再写一条同样超长的消息。被拒的出站仍然不写 `outbox`：那份台账的语义是「真的发到 QQ 了」。
  两条出站路径（标记块与 `qq_bridge_neko_send` 工具）都记进同一份丢弃台账；
  工具路径不回注会话，因为原因已经随工具结果回给模型。
- **图片占位符与描述一一对应**：原来占位符按消息里全部图片段生成，而只有落盘成功的图才进描述数组，
  第 1 张落盘失败时第 2 张的描述会落到第 1 个占位符上。现在落盘失败的位置留空位，
  输出 `[图片]（未描述）`，后面的图不顶位。
- **设置卡片支持撤销覆盖**：设置文件的值优先于插件配置页，而卡片原来只写不删，
  用户从插件配置页改了不生效，也无处重置。现在被覆盖的字段旁有「撤销覆盖」按钮，
  撤销后回落到插件配置页的值。
- **群聊判据改用 `groupId`**：原来用群名判断，`get_group_info` 失败时群消息会带
  `[QQ · 私聊]` 前缀进入上下文。现在取不到群名时写「群 `<群号>`」。
- **视觉模型列举失败不再静默**：单个 provider 的 `listModels` 抛错原来被当成「没有视觉模型」。
  现在记 warn，带 provider id 与失败原因。
- **STC 文本修订**：文档里 10 类与事实不符的说法已修正（版本号、`recentChatLimit` 默认 8、
  超长由分段改为拒发、白名单已改空、M3 已完成、文件清单尺寸等）。
  对外文档与代码注释里的直角引号与半角引号统一为全角双引号，
  行内代码与围栏代码块内的字面值保留。
- **审计第 2 轮其余条目记录在案**：出站闸门的多标志重构留待单独一轮；
  `wakeProbability` 填 `5` 被当成 100% 判为假问题（卡片已写明该字段是 0 至 1 的比例，
  并给出 0.05 = 5% 的换算与 0.01 的步进）。
- **测试总数**：四个套件 498 条断言全绿
  （`test-smoke` 372 / `test-onebot` 27 / `test-napcat` 59 / `test-stickers` 40）。

- **公开仓库脱敏：真实群号、QQ 号、私人昵称与本机路径换成占位值**：只换字面值，不改逻辑、
  不改断言结构、不删用例。
  真实群号换成 `12345678`，涉及 `test-smoke.mjs` 与 `test-stickers.mjs`。
  机器人自身 QQ 号换成 `10000001`，测试号换成 `10000002`，都在 `test-smoke.mjs`。
  私人昵称换成 `小助手`，涉及 `cordis.patch.yml`、`index.js`、`client/client.js`、
  `README.md`、`HANDOVER.md`、`test-onebot.mjs`、`test-smoke.mjs`。
  本机绝对路径换成 `<工作区>`、`<QQ 安装目录>`、`<DSH 安装目录>`，涉及
  `docs/dsh-0.2.0-migration.md` 与 `HANDOVER.md`。
  `README.md` 的断言总数由 360 更正为 417；四个套件的断言总数仍为 417。
- **未唤醒摘要的省略条数改为真实丢失量，超过 99 条写“大量消息”**：`renderDigest()` 的省略数
  原来是 `picked.length - lines.length`，只数窗口内没装下的条目。窗口外（比 `recentChatLimit`
  更早）的条目同样随快照一起删除，却没有计入，所以对模型报的丢失量偏小。
  现在省略数取 `list.length - lines.length`：`list` 是传入的缓冲快照，`lines` 是真正写进摘要的行数。
  `lines.length` 含被截断后仍然保留的那一条，这一点未变。
  省略数大于 99 时只写“更早的大量消息已省略”，不写数字，避免巨大的数字进入上下文。
  省略数为 0 时不加省略说明。`handleInbound()` 里按快照删除缓冲的行为未变。
  README 的缓冲说明与上下文上限表同步。测试新增 9 条断言。测试总数 399 → 408。
- **接住投递 Promise 的异步失败**：`handleInbound()` 的 `deliver()` 丢弃了
  `agent.followup()` / `agent.steer()` 的返回值。该返回值是 rejected Promise 时，
  既没有人接住它，也没有把台账改成 `wake-failed`，进程还会报 unhandled rejection。
  现在 `deliver()` 把返回值传出来：`withInitiator` 的返回值是 thenable 时用它的返回值；
  `withInitiator` 抛错后改调 `send()`，那一次的返回值同样传出来。
  返回值是 thenable 时挂 `.catch()`：把同一条台账条目的 `decision` 改成 `wake-failed`，
  `error` 写成“投递后这一轮失败：<原因>”，并调用 `saveState()` 与 `logger.warn`。
  这一路不回滚 `pendingFromQQ` / `currentTurnFromQQ` / `claimedFromQQ`：投递已经真的把这一轮
  开起来，三面标志已被这一轮正常消费，事后回滚会破坏下一轮的归属。
  同步失败路径保持原样，两者都不向调用方抛。测试新增 9 条断言。测试总数 408 → 417。
- **唤醒失败不再记账为成功**（严重）：`handleInbound()` 先前在 `d.action === 'wake'` 时就写了
  `decision: 'wake'` 的台账，之后 `ensureTargetAgent()` 抛错（未配置 `targetSessionId`、resume 失败）
  或投递抛错（`followup` / `steer` 抛错，含 `withInitiator` 失败后那次 `send()` 再抛）都会异常退出，
  台账里留下的仍是 `wake` —— 事后查 `status.recentLog` 看不出失败。
  现在 `pushLog()` 返回推入的条目对象，唤醒路径保留引用：投递失败时把 `decision` 就地改成
  `wake-failed` 并加上 `error`；`handleInbound()` 返回
  `{ ...d, delivered: false, wakeFailed: true, error }`，不向上抛，`action` 仍为 `wake`。
  失败时同时回滚 `pendingFromQQ` / `currentTurnFromQQ` / `claimedFromQQ` 到置位前的值
  （失败的唤醒不再污染下一轮的归属判定）。投递失败时不进入清缓冲那一步，
  失败的消息留在缓冲里，下次唤醒还能带上。
  测试新增 18 条断言覆盖这 3 个失败点、回滚与缓冲。测试总数 366 → 384。
- **视觉模型的解析结果改为按设置签名缓存**（严重）：`visionModelCache` 原来只存一个值，
  一个进程内只解析一次。用户在设置卡片里填 `visionModel` 不生效；部署当时没有可用视觉模型时，
  之后补上模型仍然返回“没找到支持图片输入的模型”。现在缓存是 `{ signature, model }`，
  签名取 `visionModel` 的值。签名不同就重新解析，解析失败的 `null` 也带签名。
  `applySettingChanges()` 丢掉“解析失败”的缓存，所以之后补上视觉模型时，
  改任何设置都会重试一次；成功的解析照旧按签名缓存。
  测试新增 15 条断言覆盖缓存命中、`null` 缓存、改值后重新枚举、失败结果的重试与描述路径用到新模型。
  测试总数 384 → 399。
- **未唤醒摘要的清缓冲说明改为与真实行为一致**：只改注释与文档，行为未变。
  投递成功后按快照删除缓冲里的**全部**条目，没进摘要的旧条目也一起删掉，不会留到下一次唤醒。
  `index.js` 的注释、README 与 CHANGELOG 里的描述同步修正。
- **默认值修正**：`cordis.patch.yml` 里的 `targetSessionId` 与 `whitelist` 不再带占位值
  （原来的 `'<TARGET_SESSION_ID>'` 与 `['test-user']`），两项都改为空。
  空 `targetSessionId` = 不驱动任何会话；空 `whitelist` = fail-closed，任何来源都不能唤醒会话。
  README 的设置项表同步了这一默认值。
- **超长出站改为拒绝发送**：出站文本超过 `replyMaxChars` 时**一条都不发**，不再分段。
  `sendToQQ()` 返回 `{ sent: 0, dropped: true, reason: 'too-long', limit, length }`。
  删除了分段函数 `chunkText()` 与分段发送路径。拒绝原因会经 `qq_bridge_neko_send` 的返回、
  标记块模式的日志、用法说明与设置项说明传到模型侧，文案统一为“超过上限的回复不会发出，请缩短后重发”。
- **表情包措辞更新**：用法说明里加一条：发了表情包不要解释它是什么意思（除非有人问）。
  人自己看得懂表情包，解释反而奇怪。
- **出站台账只记真话**：`outbox` 只记录真正发出去的消息。
  被拒绝的发送（超长、未连接、无目的地）不再落台账，只写 warn 日志。
  原来的写法会让台账里出现 QQ 里根本没有的消息，事后对不上账。
- **测试修复：出站用例改为看真实发送帧**（严重）：主 ctx 从未连上传输，
  12 条出站用例靠假台账被误判为通过，实际每条都是 `reason: 'not-connected'`。
  现在为主 ctx 装上能连上的假 WebSocket，判据改为 `send_group_msg` /
  `send_private_msg` 帧里的文本。负面用例同时检查真实帧与台账 2 个口径。
  新增 2 条断言钉住传输处于 `open`。测试总数 361 → 366。

## v0.1.2 — 2026-10-10

- **设置卡片的“启动 NapCat”按钮反映运行状态**：NapCat 运行中时，按钮显示“已在运行”并禁用，
  不再重复启动。宿主半新增 `napcatRunning()`，判据有 2 条：本插件启动的进程还没结束，
  或 OneBot WS 已连接（`transport.isOpen()`）。第 2 条用于识别外部启动的 NapCat，例如手动跑过 bat。
  `GET /api/qq-bridge-neko/napcat` 的返回值新增 `running` 与 `startedByPlugin` 两个布尔字段。
  `POST /api/qq-bridge-neko/napcat/launch` 在 NapCat 已运行时不再启动，
  返回 `{ ok: false, error: 'NapCat 已在运行，未重复启动' }`。
  卡片展开期间每 5 秒轮询一次该接口，用于发现外部启动。
  卡片收起或组件卸载时清掉定时器。
  启动请求结束后，按钮重拉一次状态，成功与失败都重拉。
- **NapCat 启动改为按布局探测，并优先调用官方 launcher**（真机修复）：以前把路径写死成
  `<安装目录>/bootmain/NapCatWinBootMain.exe`。用户把 `napcatInstallDir` 设成 `NapCat.Shell` 子目录时，
  这条路径必然不存在，点“启动 NapCat”只会报“找不到 …，先跑 action:download”。
  现在 `napcatPaths()` 按候选顺序探测，**OneKey 根与 `NapCat.Shell` 子目录两种布局都能解析**：
  `shellDir` 取存在的 `<安装目录>/NapCat.Shell`，不存在时取 `<安装目录>`；
  `bootMain` 依次取 `<shellDir>/bootmain/…`、`<安装目录>/bootmain/…`、`<shellDir>/NapCatWinBootMain.exe`；
  新增 `shellDir`、`hookDll`、`launcherBat` 三个字段。
  启动时优先执行官方 `launcher-win10.bat`（工作目录设为 `shellDir`）：该脚本自己读注册表找 QQ 路径，
  非管理员时用 UAC 自我提权，所以**可能弹出 UAC 窗口**。
  没有 launcher 脚本时才直接调用引导器，参数改为官方顺序
  `<bootMain> <QQ.exe 路径> <hook.dll> [-q <QQ号>]`；以前只传了 `<bootMain> <QQ号>`，
  并且工作目录是 `bootmain`，路径即使对也起不来。
  错误信息现在写明**期望路径**与**下一步动作**，且不含 token 值。
- **设置卡片新增 3 个操作按钮**：展开卡片后可以**打开 WebUI**、**启动 NapCat**、**打开文件夹**。
  打开 WebUI 的地址由 `<安装目录>/config/webui.json` 里的 host / port / token 拼成（没读到就禁用并写明原因）；
  启动复用 `qq_bridge_neko_napcat` 的 launch；打开文件夹按系统调用 `explorer.exe` / `open` / `xdg-open`。
  宿主半新挂 `GET /api/qq-bridge-neko/napcat` 与 `POST /api/qq-bridge-neko/napcat/launch|reveal` 三条
  **不受 legacy 门控**的路由（两代宿主都有），只服务本机：非 loopback 一律 403。
  token 只拼进 URL，不写日志。
- **出站更新（二次确认）**：工具模式下，不是 QQ 唤醒的那一轮不再“硬拒绝”。第一次调用只回一句确认、
  **不会发出去**；同一轮里**再调一次**才真的发（确认状态按轮清零，不会跨轮泄漏；非 QQ 轮的发送在
  outbox 里标 `nonQQTurn: true`）。
- **图片描述改为就地标注**：以前描述另起一段附在消息末尾，模型会读成“这张图没解析出来、后面又来了一张”；
  现在直接把描述填回图片原来的位置，形如 `[图片]：<描述>`（2026-10-02 起改成 `[图片#<短哈希>]：<描述>`，见本节末条）。
- **戳一戳更新**：戳一戳走的是 **notice 事件**（不是消息段），以前会被静默丢掉；现在“戳我”和 @ 我同级
  **必唤醒**，戳别人只记录不唤醒，其它 notice 会留一条日志方便后续适配。
- **兼容 DSH 0.2.0 的设置页**：0.2.0 换了**两处**名字 —— 客户端设置服务从 `settingsScope` 变成
  `webUiSettings`，插件配置页的挂载点从 `settings.plugin.item` 变成 `settings.plugins.tab`（插件自己是一个 tab）。
  插件现在**两个服务门、两个 slot 各注册一次**，哪个存在哪个生效，0.1.5-rc.3 与 0.2.0 都能显示设置卡片。
- **兼容 DSH 0.2.0 的宿主设置模型**（真机修复）：0.2.0 删掉了 `settings.register/get`（DSH #677），
  设置表单改为从插件自己的 `Config` 派生。老代码在 `apply()` 里无条件 `register` 会抛 TypeError →
  **整条 fiber failed**（客户端半照样显示 tab，看起来就像“设置项全没了”）。现在按方法探测走两条路：
  老宿主维持命名空间，新宿主直接读 entry 配置并 `configure({ auto: true })` 生成页面。
  顺带修掉 `readSettings()` 里若干字段没回落 `config` 的隐患（新模型下会悄悄丢用户配置）。
  客户端卡片也**两个可写设置 key 都绑**（0.1.5 的 `qq-bridge-neko` vs 0.2.0 的 `include:qq-bridge-neko`），谁 ready 用谁。
- **兼容 DSH 0.2.0 的消息格式 v4**：v4 废弃了 `source.kind === 'plugin'`（`assertV4MessageSources` 直接抛
  “requires a producer-owned source kind”），导致 QQ 唤醒的轮次整个失败。注入消息的 source 改为按宿主分叉：
  0.1.5 用老包装、0.2.0 用 producer-owned 的 `{ kind: 'plugin:dsh-qq-bridge' }`（`injectedMessageSource()`，导出可测）。
- **0.2.0 上设置卡片可用了（自建设置通道）**：0.2.0 的宿主设置桥对第三方插件不给可写域（#677 迁移未完成），
  于是照抄生态里真正能用的做法（皮肤中心）：宿主半**可选**注入 `webServer`，挂一条**只服务本机**的
  `GET/POST /api/qq-bridge-neko/settings`；值存 `$DSH_HOME/qq-bridge-neko-settings.json`
  （优先级：设置文件 > composition config）；浏览器半在拿不到可写域时自动改走这个接口。
  非 loopback 请求一律 403，只写 schema 白名单里的键。0.1.5 与 0.2.0 上都能改设置了。
- **表情包（新功能）**：群友发的图可以登记成表情包，之后按情绪或哈希再发出去。新模块 `stickers.js`
  （纯函数 + 文件读写，导出以便测试）：`hashOfBuffer()` 取图片字节 sha256 的前 16 位十六进制，
  `loadStickers()` / `saveStickers()`（原子写，读不到或坏了返回空表）、`upsertSticker()` /
  `findSticker()` / `listStickers()`、`importSticker()`（算 hash、按需复制图片本体、登记）。
  登记表存 `<statePath 目录>/qq-bridge-neko-stickers.json`，图片本体存同目录的 `qq-bridge-neko-stickers/<hash>.<ext>`。
  新工具 `qq_bridge_neko_sticker`（**不受 `debugTools` 限制**）有 3 个 action：`list` 列已登记的
  （短哈希 / mood / 截断描述 / 大小）、`save` 登记一张图（给 `hash`，或 `fromLast: true` 取缓冲区里最近一张；
  `mood` 与 `description` 必填）、`send` 发一张（给 `hash` 精确发，或只给 `mood` 在该情绪里随机挑一张）。
  发送与 `qq_bridge_neko_send` 共用同一道来源闸门（抽出为 `outboundGate()`）；图片本体用 `base64://` 发送，
  不用本地路径（NapCat 的 `enableLocalFile2Url` 是 false）；成功记 outbox（`via: 'tool'`、`action: 'sticker'`）
  并更新该条的 `sentCount` / `lastSentAt`。
- **图片占位符带短哈希 + 描述缓存命中**：入站占位符从 `[图片]：<描述>` 改成 `[图片#<短哈希>]：<描述>`
  （描述失败写成 `[图片#<短哈希>]：（描述失败：原因）`），模型据此能指着一张具体的图交给 `qq_bridge_neko_sticker`；
  注入的系统提示同步改了格式说明。图片缓存的文件名改成内容哈希（`<hash>.<ext>`）：同一张图不重复落盘，
  命中已有文件时也拿得到哈希。`describeImage()` 先查登记表，命中且有 `description` 时**直接返回登记的描述、
  不调用多模态模型**（反复出现的图只描述一次），日志只记短哈希。新增测试套件 `test-stickers.mjs`（40 条）；
  `test-smoke.mjs` 增加描述缓存命中、入站短哈希渲染与表情包工具的断言。





## v0.1.1 — 2026-10-01

生活更新（补丁版，无破坏性改动）。

- 识图：改成让模型**逐字抄下图中所有可见文字**再说明画面，token 上限 300 → 600。
  说明：描述偏短的原因是提示词要求 1 至 2 句，不是代码截断。
- 设置卡片：改成折叠块，点标题展开；界面里可以改的设置项补齐（含 visionModel、agentPreset）。
- OneBot 地址/token 栏加形状校验，避免把整段配置粘进单栏。
- 目标会话下拉不再列出已归档的会话（当前值仍保留，不会把你的选择吞掉）。

本项目遵循语义化版本。**v0.1.0 是第一次公开发布。**

## [0.1.0] — 2026-09-30

把**一个已存在的、固定的 DSH 会话**接到 QQ（OneBot / NapCat），**保留原上下文**，
并用一套省 token 的唤醒策略决定哪些 QQ 消息真正唤起模型。

**和同类 QQ 插件的区别**：接的是**同一个老会话**（不新建、不重置人设），并且**唤醒要花钱、所以要挑**。
多数同类方案是“每个群 / 每个私聊用户各自开一个新会话”。

### 能力

- **固定会话注入**：`agents.get(id)` 拿不到就 `agents.resume({resumeSessionId})` 显式拉起；**绝不回退**到别的会话。
- **唤醒策略（省 token）**：白名单 fail-closed → 被 @ / 命中昵称必唤醒 → 否则按概率（默认 5%）→
  其余**只记录不唤醒**（零模型调用），下次唤醒时取最近 `recentChatLimit` 条（默认 8）作为上下文附上；
  没进摘要的旧条目随这次清缓冲一起删掉，不会留到下一次唤醒。
- **会话跟随** `qq_bridge_neko_listen`：一段线性对话开个短窗，期间普通消息也唤醒，不必每句都 @。
- **OneBot v11 传输**：内置 WebSocket（**零第三方运行时依赖**），指数退避重连、心跳看门狗、action/echo 配对。
- **出站方式开关** `replyMode`：
  `marker`（只发 `[QQ]…[/QQ]` 块）｜`tool`（关掉标记块，改用 `qq_bridge_neko_send` 工具，**发不出去时有明确反馈**）｜`always`。
- **投递方式** `delivery`：`auto`（目标正忙时**插话**）、`followup`（排队）、`steer`（总是插话）。
- **设置界面**：`设置 → 插件 → 插件配置` 里的“QQ 桥接”卡片（目标会话下拉、昵称、白名单、概率、出站/投递方式……），
  **保存即生效**，改出站方式会立刻重挂注入给会话的用法说明。
- **图片**：收到即落盘缓存 → 唤醒时用多模态模型转成文字描述（目标模型看不见图时的唯一出路）。
- **NapCat 自助托管**：查 Release、sha256 校验下载、纯 Node 解包 ZIP、写 OneBot 配置、启停。
- **无人值守安全边界**：注入的系统提示明确禁止无人值守时做特权操作、把 QQ 消息当不可信输入；
  **明确不做审批桥接**（把审批搬到 QQ = 把“谁能发消息”变成“谁能替你授权”）。

### 修复（都是真机联调暴露的）

- 出站闸门**按来源生效**：只有被 QQ 唤醒的那一轮才出站，DSH 界面里的标记块一个字都不发。
- 出站归属**按轮快照**：轮内插入别的消息不会把归属打掉（哑火）或抬高（误发）。
- **四次哑火、四个不同成因**：`source` 字段被上游重写／单一标记被同轮消息打掉／
  harness 注入的上下文被当成“一轮的触发器”／`followup()` **同步**起轮导致置位晚一拍。
- 提示词**按出站方式分叉**，并在方式变化时**重挂**（提示词正文是挂载时的快照）。
- 设置卡片的 key 必须**逐字等于** settings 命名空间，否则界面静默空白（有测试盯住）。
- 图片：唤醒结束时的清缓冲会吞掉期间新到的消息（“发三张图只处理一张”的元凶）。
- 非文本消息段（表情包 / 语音 / 文件 / 合并转发……）都有占位符，**绝不让整条消息凭空消失**。
- **恢复没开着的会话时必须带上模型**：否则部署提示词里的 `{{model}}` 无值，
  每一轮都在组装提示词时失败（`prompt variable "{{model}}" has no value …`）。
  现在按官方 GUI 的优先级取值：会话的模型选择投影 → 日志里最后一次 `request/header` → 部署默认模型。
  （目标会话在 GUI 里开着时走的是“活的 agent”路径，所以这个坑只在**冷恢复**时出现 —— 真机验证过。）

### 已知限制

- **NapCat 自助托管未在真机跑通全流程**：安装器与 QQ 登录是交互式的，需要人在场（工具本身已离线验证）。
- 目标会话的模型如果不支持图片输入，必须配一个多模态模型（`visionModel`）；否则只看到“图片省略”。
- 白名单为空 = **谁都不能唤醒**（fail-closed），第一次用必须先把群号 / QQ 号填进去。
- 回复方式选 `tool` 时，每轮多一次模型调用（工具结果回来还要再出一轮）。