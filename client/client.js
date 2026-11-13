/**
 * dsh-qq-bridge-neko —— 浏览器半（client half）
 *
 * 作用：在 **设置 → 插件 → 插件配置** 里放一张名为“QQ 桥接 Neko”的卡片，
 * 用来改昵称、白名单、唤醒概率、目标会话这些设置 —— 也就是用户要的那个界面。
 *
 * 为什么这里的东西长得不像源码：
 *   DSH 的官方文档明确说，本仓库之外没有现成的 client 打包预设
 *   （`packages/client/tsdown.client.ts` 不发布），外部插件得自己复刻产物格式。
 *   好在格式很简单：`window.__ModuleLoader__.load({ id, factory })`，
 *   `factory(require)` 返回一个带 `apply` / `inject` 的 Cordis 插件。
 *   这里就是**手写**这个格式，不引入任何构建步骤。
 *   参考实现：第三方插件 `dshmarket` 的 `client/client.js`（同样是手写/预构建产物）。
 *
 * 与宿主半的约定：
 *   - `id` 必须等于 npm 包名 `@fengye_nobug/dsh-qq-bridge-neko`；
 *   - 卡片注册进 `settings.plugin.item`，**key 必须等于宿主注册的 settings 命名空间** `qq-bridge-neko`，
 *     否则配置页那一栏里什么都不会出现（它按命名空间派发）。
 */
window.__ModuleLoader__.load({
  id: '@fengye_nobug/dsh-qq-bridge-neko',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // react 是模块表里的 baseline 依赖，不用在 package.json 里声明 external。
    const react = require('react')
    const h = react.createElement

    /** settings 命名空间，必须与 index.js 里的 NS 一致。 */
    const NS = 'qq-bridge-neko'

    // ── 表单描述 ──────────────────────────────────────────────────────────────
    // 加一个设置项 = 在这里加一行。kind:
    //   text | list | group-list | number | boolean | select | session
    //   vision-provider / vision-model | preset | model-chain | profiles
    const FIELDS = [
      {
        key: 'checkUpdateOnStart',
        label: '启动时检查一次',
        kind: 'boolean',
        hint: '默认关。打开并保存后，下次启动只检查有没有新版本，写在日志里，不会自动安装。',
      },
      {
        key: 'sessionScope',
        label: '会话怎么分',
        kind: 'select',
        options: [
          ['single', '所有群共用一个会话'],
          ['perGroup', '每个群、每个私聊各记各的'],
        ],
        hint: '共用一个会话：所有 QQ 消息都进下面选的那一个会话。各记各的：每个群、每个私聊自动开一条上下文，互不抢回复。',
      },
      {
        key: 'maxRecentTurns',
        label: '每个会话最多留几轮',
        kind: 'number',
        hint: '默认 40。聊太长会尽量把更早的内容压缩掉，回复更快。填 0 表示不限制。',
      },
      {
        key: 'targetSessionId',
        label: '接到哪个会话',
        kind: 'session',
        hint: '按名字选就行，不用记那串 id。选「每个群、每个私聊各记各的」时可以留空，留空就用宿主当前的默认模型；填了则新建的会话沿用这个会话的模型。',
      },
      {
        key: 'newSessionDir',
        label: '新建会话放在哪个文件夹',
        kind: 'text',
        hint: '「每个群、每个私聊各记各的」时，新会话用这个目录。填绝对路径，例如 D:\\QQ工作区。留空 = 用宿主的默认工作目录。',
        check: (v) => {
          const s = String(v ?? '').trim()
          if (s === '') return null
          return /^([A-Za-z]:[\\/]|\\\\|\/)/.test(s) ? null : '要填绝对路径（例如 D:\\QQ工作区）。相对路径面板打不开。'
        },
      },
      {
        key: 'newSessionModel',
        label: '新建会话默认模型',
        kind: 'model-ref',
        hint: '新建的群/私聊会话先用这个模型。留空 = 用宿主默认模型；模型优先级链有内容时用链上第一个。',
      },
      {
        key: 'newSessionPreset',
        label: '新建会话默认预设',
        kind: 'preset',
        hint: '新建的群/私聊会话挂哪套人设。留空 = 不挂载。',
      },
      {
        key: 'pruneBlankSessions',
        label: '顺手清掉没用的空白会话',
        kind: 'boolean',
        hint: '同一目录里从没聊过、也没在用的会话，会在新建 QQ 会话时自动归档（能取消归档）。不打开这个，面板点「新建会话」会一直复用同一条旧空壳，看着像没新建。',
      },
      {
        key: 'nicknames',
        label: '听到这些名字就回应',
        kind: 'list',
        hint: '别人喊到这些名字就一定回话。用逗号分开，例如：244, 小助手。',
      },
      {
        key: 'wakeProbability',
        label: '没点名时的回应概率',
        kind: 'number',
        step: '0.01',
        hint: '没 @、也没喊名字时，按这个概率回话（0 到 1）。默认 0.05，也就是大约二十条里回一条。想少说话就调小。',
      },
      {
        key: 'alwaysWakePrivate',
        label: '主人的私聊必回',
        kind: 'boolean',
        hint: '打开后，「主人 QQ」里的号发来的私聊一律回话，不按概率抽签。别人的私聊和所有群不受影响。',
      },
      {
        key: 'whitelist',
        label: '哪些私聊可以叫醒',
        kind: 'list',
        hint: '填 QQ 号，用逗号分开。留空 = 任何私聊都不会叫醒机器人。',
      },
      {
        key: 'groupWhitelist',
        label: '哪些群可以叫醒',
        kind: 'group-list',
        hint: '填群号，用逗号分开。留空 = 任何群都不会叫醒机器人。查到群名时，群号旁边会显示名字和头像；没连上或查不到就只显示群号，照样能保存。',
      },
      {
        key: 'ownerWhitelist',
        label: '主人 QQ',
        kind: 'list',
        hint: '填主人的 QQ 号，用逗号分开。只有这些号能在 QQ 里用「白名单」命令。留空 = 这些命令不会生效。',
      },
      {
        key: 'atOnlyInGroup',
        label: '群里必须 @ 才理',
        kind: 'boolean',
        hint: '打开之后，群里没 @ 机器人就当没看见。比上面的概率更严。',
      },
      {
        key: 'destinationProfiles',
        label: '每个群 / 私聊单独设置',
        kind: 'profiles',
        hint: '在这里给某个群或某个私聊单独定：几点到几点休眠不看消息、是不是 24 小时实时回复、对方连着发消息时等多久再回、多久没新消息就停止跟随。没列出来的目的地按上面的全局设置走。',
      },
      {
        key: 'burstWaitMs',
        label: '连着发消息时先等多久',
        kind: 'number',
        hint: '对方还在连着发时，先攒着不回；停了这么久（毫秒）才一次性回。默认 0 = 立刻回。单个群/私聊可以在上面单独覆盖。',
      },
      {
        key: 'listenIdleMs',
        label: '多久没新消息就停止跟随',
        kind: 'number',
        hint: '会话跟随（模型自己开的「继续听」窗口）在对方安静这么久（毫秒）后自动收尾。默认 120000 = 2 分钟。',
      },
      {
        key: 'replyGapMinMs',
        label: '分条发送最短间隔',
        kind: 'number',
        hint: '一轮里分几条发时，两条之间最少隔多少毫秒。默认 1200。',
      },
      {
        key: 'replyGapMaxMs',
        label: '分条发送最长间隔',
        kind: 'number',
        hint: '一轮里分几条发时，两条之间最多隔多少毫秒。默认 2800。太快会像机器人在刷屏。',
      },
      {
        key: 'voiceEnabled',
        label: '可以发语音',
        kind: 'boolean',
        hint: '打开后，正文里写 [语音]要念的台词[/语音] 就会合成成语音发出去，一个语音块 = 一条消息。关着时这些标记原样当文字发。',
      },
      {
        key: 'ttsProvider',
        label: '声音模块',
        kind: 'voice-module',
        options: [
          ['edge', 'edge-tts（微软的，在本机 python 里跑）'],
          ['sherpa', 'sherpa（本地离线模型，不联网）'],
          ['feiyu', '肥鱼声音服务（本机服务，要先把它起起来）'],
        ],
        hint: '二选一：本地合成（edge / sherpa）或肥鱼声音服务。选哪个就只显示哪一套设置，另一套收起来但值不会丢。',
      },
      {
        key: 'ttsVoice',
        label: '音色',
        kind: 'text',
        hint: 'edge-tts 的音色名，例如 zh-CN-XiaoyiNeural（女声，偏软）、zh-CN-XiaoxiaoNeural、zh-CN-YunxiNeural（男声）。',
      },
      { key: 'ttsRate', label: '语速', kind: 'text', hint: '相对语速，例如 -8%（慢一点）、+0%。' },
      { key: 'ttsPitch', label: '音高', kind: 'text', hint: '相对音高，例如 +12Hz（高一点）、+0Hz。' },
      {
        key: 'ttsPythonPath',
        label: '哪个 python 能跑 edge-tts',
        kind: 'text',
        hint: '填装好 edge-tts 的 python.exe 绝对路径。留空 = 用 PATH 里的 python（大多数系统 python 没装 edge-tts，会合成失败才降级发文字）。',
      },
      {
        key: 'voiceMaxChars',
        label: '一条语音最多多少字',
        kind: 'number',
        hint: '超过这个字数就不合成、直接发文字（前面加「语音没合成出来」）。默认 120。',
      },
      {
        key: 'voiceCacheDir',
        label: '语音缓存放哪',
        kind: 'text',
        hint: '留空 = $DSH_HOME/qq-bridge-neko-voice。同一段话 + 同一个引擎同一套参数命中缓存，不会重复合成。',
      },
      { key: 'ttsSid', label: 'sherpa 用哪个说话人', kind: 'number', hint: '模型里第几个音色，从 0 开始。默认 0。' },
      { key: 'ttsSpeed', label: 'sherpa 语速倍数', kind: 'number', hint: '1 = 原速，1.2 快一点，0.8 慢一点。默认 1。' },
      {
        key: 'ttsModelDir',
        label: 'sherpa 模型放哪',
        kind: 'text',
        hint: '本地离线合成用的模型目录，里面要有 model.onnx、tokens.txt 那几样。留空 = $DSH_HOME/tts-models/vits-melo-tts-zh_en。',
      },
      {
        key: 'ffmpegPath',
        label: '转 mp3 用哪个 ffmpeg',
        kind: 'text',
        hint: '肥鱼吐的是 wav，转成 mp3 更好发。留空 = 先找 PATH 上的 ffmpeg，再找本机自带的 D:\\小丸\\tools\\ffmpeg.exe；都没有就原样发 wav，不算失败。',
      },
      {
        key: 'feiyuBaseUrl',
        label: '肥鱼声音服务地址',
        kind: 'text',
        hint: '本机那个声音服务的地址，默认 http://127.0.0.1:9880。得先把服务起起来，语音才合成得出来。',
      },
      {
        key: 'feiyuApiKey',
        label: '肥鱼服务口令',
        kind: 'secret',
        hint: '服务要求的 Bearer 口令。留空 = 不带鉴权头。存过之后这里不会再显示出来，想换直接重填。',
      },
      {
        key: 'feiyuVoice',
        label: '肥鱼音色',
        // 下拉而不是手打：清单由宿主半去打声音服务的 /v1/capabilities 拿（见 catalog 接口）。
        // 服务没起时退回下面这份内置项 —— 当前发布的包里确实只注册了 feiyu 一个音色。
        kind: 'feiyu-voice',
        options: [['feiyu', 'feiyu（默认音色）']],
        hint: '选声音服务里注册的音色，默认 feiyu。没连上服务时只能选内置的那一个。',
      },
      {
        key: 'feiyuStyle',
        label: '肥鱼语气',
        kind: 'select',
        options: [
          ['cute', 'cute（软一点）'],
          ['gentle', 'gentle（温柔一点）'],
        ],
        hint: '肥鱼服务的语气风格，默认 cute。只在合成时用得上。',
      },
      { key: 'feiyuTimeoutMs', label: '肥鱼最多等多久', kind: 'number', hint: '毫秒。第一次合成本机要加载模型、会慢一些，默认 180000。' },
      { key: 'feiyuPollIntervalMs', label: '肥鱼隔多久问一次', kind: 'number', hint: '毫秒。任务排队时多久查一次进度，默认 1000。' },
      {
        key: 'feiyuSingTimeoutMs',
        label: '唱歌最多等多久',
        kind: 'number',
        hint: '毫秒。唱歌要跑谱面编译 + SVS 出声 + 换声 + 混音，比说话慢一个量级，默认 600000（10 分钟）。',
      },
      {
        key: 'voiceMaxSongChars',
        label: '一首歌最多几个字',
        kind: 'number',
        hint: '一个音符一个字，所以这就是最多唱多少个音符。15 秒的小曲约 10 个字，一分钟一百多字。默认 400。',
      },
      {
        key: 'visionMode',
        label: '识图用哪个模型',
        kind: 'select',
        options: [
          ['auto', '自动挑一个能看图的'],
          ['session', '用会话当前的模型'],
          ['fixed', '指定一个模型'],
        ],
        hint: 'auto = 从已配置的提供商里找一个支持图片输入的；session = 直接用这条会话自己的模型看图；fixed = 用下面选的那一对。',
      },
      {
        key: 'visionProvider',
        label: '识图提供商',
        kind: 'vision-provider',
        hint: '从 DSH 里已经配置好的模型提供商里选。只有「识图用哪个模型」选了「指定一个模型」才生效。',
      },
      {
        key: 'visionProviderModel',
        label: '识图模型',
        kind: 'vision-model',
        hint: '这个提供商下用哪个模型。带「支持识图」标记的才真能看图。',
      },
      {
        key: 'modelChain',
        label: '对话模型优先级',
        kind: 'model-chain',
        hint: '按顺序尝试：上面那个连续报错达到次数上限，就自动换下一个（会话里直接切，不丢上下文）。拖动顺序用上下箭头。留空 = 不启用。',
      },
      {
        key: 'modelChainFailures',
        label: '连续报错几次就换模型',
        kind: 'number',
        hint: '默认 5。同一个模型连续失败这么多次（一轮里的错误都算）就切到优先级里的下一个。',
      },
      {
        key: 'describeImages',
        label: '收到图片先读成文字',
        kind: 'boolean',
        hint: '打开时叫一个能看图的模型把图描述出来，正文里就能看到图里是什么。关掉只留图片位置标记。',
      },
      {
        key: 'replyMode',
        label: '群里发出去的是哪一段',
        kind: 'select',
        options: [
          ['marker', '只发「发给群」里的那段'],
          ['tool', '用发消息工具'],
          ['always', '整段回答都进群（慎用）'],
        ],
        hint: '「发给群」的那段要用 [QQ] 和 [/QQ] 包起来，包外面的话不会进群。选「用发消息工具」就改调 qq_bridge_neko_send。选「整段回答都进群」会把思考过程也发出去，一般别用。',
      },
      {
        key: 'delivery',
        label: '忙的时候怎么插话',
        kind: 'select',
        options: [
          ['auto', '能插就插，不能就排队（推荐）'],
          ['followup', '一律新开一轮'],
          ['steer', '不管忙不忙都插'],
        ],
        hint: '推荐：会话正忙就插进去接着说，闲着就排队等下一轮。「一律新开一轮」每次都等当前这轮结束。「不管忙不忙都插」会打断正在做的事。',
      },
      { key: 'replyWithQuote', label: '回复时带上原消息', kind: 'boolean', hint: '回话时引用那条把机器人叫醒的消息。' },
      { key: 'stripMarkdown', label: '去掉 Markdown 记号', kind: 'boolean', hint: '发出去之前拿掉 **粗体**、`代码` 这类记号。QQ 不会渲染它们。' },
      {
        key: 'replyMaxChars',
        label: '一条最多多少字',
        kind: 'number',
        hint: '超过这个字数就整条不发，需要缩短后再发。',
      },
      {
        key: 'onebotUrl',
        label: 'OneBot 连接地址',
        kind: 'text',
        hint: 'NapCat 的 WebSocket 地址，例如 ws://127.0.0.1:3001。留空 = 先不连接。',
      },
      {
        key: 'accessTokenEnv',
        label: 'OneBot 令牌放在哪个环境变量',
        kind: 'text',
        hint: '填环境变量的名字（例如 NAPCAT_TOKEN），不要把令牌本身贴进来。这也不是模型的 API key。NapCat 没开令牌校验就留空。',
        check: (v) => {
          const s = String(v ?? '').trim()
          if (s === '') return null
          if (/^(sk-|Bearer\s)/i.test(s) || s.length > 64 || /[.\s]/.test(s)) {
            return '这里要填的是环境变量名（例如 NAPCAT_TOKEN），不是令牌本身，也不是模型的 API key。'
          }
          return null
        },
      },
      { key: 'selfId', label: '机器人自己的 QQ 号', kind: 'text', hint: '留空 = 连上之后自动读取。' },
      {
        key: 'agentPreset',
        label: '人设预设',
        kind: 'preset',
        hint: '已有会话恢复时用哪套人设。留空 = 沿用那个会话自己记着的。新建会话用上面的「新建会话默认预设」。',
      },
      { key: 'attachRecentChat', label: '把没叫醒时的聊天一并带上', kind: 'boolean', hint: '下次叫醒时，把中间没理的那些话一起附上。' },
      { key: 'recentChatLimit', label: '附带最近几条', kind: 'number', hint: '上面那段最多带最近几条（0–200）。' },
      {
        key: 'rotateEnabled',
        label: '聊太久自动换新会话',
        kind: 'boolean',
        hint: '「每个群、每个私聊各记各的」时，聊得太久或上下文快满就自动开一条新会话接着聊。旧会话留着能查，不会删。',
      },
      {
        key: 'rotateMaxTurns',
        label: '聊到几轮换新会话',
        kind: 'number',
        hint: '默认 300 轮。填 0 = 只看上下文压力，不按轮数换。',
      },
      {
        key: 'rotatePressureRatio',
        label: '上下文占用到多少换新会话',
        kind: 'number',
        step: '0.05',
        hint: '默认 0.75，也就是快占满四分之三时换。填 0 = 只看轮数。',
      },
      {
        key: 'autoStartNapcat',
        label: 'DSH 启动后自动启动 NapCat',
        kind: 'boolean',
        hint: '默认关。打开后 DSH 起来、等下面那个延迟，就自动启动已经装好的 NapCat；插件只启动，绝不会自动下载或安装。没装好、没配置、没登录过的话会记一条日志跳过。',
      },
      {
        key: 'autoStartNapcatDelayMs',
        label: '自动启动延迟（毫秒）',
        kind: 'number',
        step: '1000',
        hint: '默认 20000（20 秒），给 DSH 和 QQ 一点先起来的时间。可填 0–600000；填 0 = 起来就立刻尝试启动。',
      },
      {
        key: 'napcatInstallDir',
        label: 'NapCat 安装目录',
        kind: 'text',
        hint: '留空 = $DSH_HOME/napcat。自己装的或 Docker 里的 NapCat 不在这个默认位置，请填实际目录。',
      },
      {
        key: 'napcatWebuiUrl',
        label: 'NapCat 网页管理地址',
        kind: 'text',
        hint: '可选。留空就读安装目录里的 webui.json。那边通常是 127.0.0.1，只有跑着 NapCat 的那台机器能打开。远程使用时填一个外面打得开的地址。',
      },
      { key: 'napcatVersion', label: '要下载的 NapCat 版本', kind: 'text', hint: '例如 v4.18.28。留空 = 下载最新版。' },
      { key: 'downloadProxy', label: '下载时走的代理', kind: 'text', hint: '例如 http://127.0.0.1:7890。留空 = 先看环境变量，没有就直接下载。' },
      {
        key: 'onebotPort',
        label: 'OneBot 端口',
        kind: 'number',
        hint: '写进 NapCat 配置、也用来连接的端口。NapCat 如果是自己另外部署的，这里要和那边的端口一致。',
      },
      { key: 'qqNumber', label: '快速登录用的 QQ 号', kind: 'text', hint: '需要先在 NapCat 里成功登录过一次。' },
    ]

    // ── 分类 ──────────────────────────────────────────────────────────────────
    // 设置项按主题分页，一次只显示一页 —— 60 多个字段铺成一长条没人看得下去。
    // 加字段时把 key 放进某一组；忘了放也不会丢，会落进自动补的「其他」页。
    const GROUPS = [
      {
        id: 'connect',
        label: '连接',
        keys: ['onebotUrl', 'onebotPort', 'accessTokenEnv', 'selfId', 'qqNumber'],
      },
      {
        id: 'wake',
        label: '唤醒',
        keys: ['nicknames', 'wakeProbability', 'alwaysWakePrivate', 'whitelist', 'groupWhitelist', 'ownerWhitelist', 'atOnlyInGroup'],
      },
      {
        id: 'session',
        label: '会话',
        keys: [
          'sessionScope',
          'targetSessionId',
          'newSessionDir',
          'newSessionModel',
          'newSessionPreset',
          'pruneBlankSessions',
          'maxRecentTurns',
          'rotateEnabled',
          'rotateMaxTurns',
          'rotatePressureRatio',
          'agentPreset',
        ],
      },
      {
        id: 'reply',
        label: '回复',
        keys: [
          'replyMode',
          'delivery',
          'replyWithQuote',
          'stripMarkdown',
          'replyMaxChars',
          'replyGapMinMs',
          'replyGapMaxMs',
          'burstWaitMs',
          'listenIdleMs',
          'destinationProfiles',
          'attachRecentChat',
          'recentChatLimit',
        ],
      },
      {
        id: 'voice',
        label: '声音',
        keys: [
          'voiceEnabled',
          'ttsProvider',
          'ttsVoice',
          'ttsRate',
          'ttsPitch',
          'ttsPythonPath',
          'ttsSid',
          'ttsSpeed',
          'ttsModelDir',
          'voiceMaxChars',
          'voiceCacheDir',
          'ffmpegPath',
          'feiyuBaseUrl',
          'feiyuApiKey',
          'feiyuVoice',
          'feiyuStyle',
          'feiyuTimeoutMs',
          'feiyuPollIntervalMs',
          'feiyuSingTimeoutMs',
          'voiceMaxSongChars',
        ],
      },
      {
        id: 'vision',
        label: '看图',
        keys: ['describeImages', 'visionMode', 'visionProvider', 'visionProviderModel'],
      },
      { id: 'model', label: '模型', keys: ['modelChain', 'modelChainFailures'] },
      {
        id: 'napcat',
        label: 'NapCat',
        keys: ['autoStartNapcat', 'autoStartNapcatDelayMs', 'napcatInstallDir', 'napcatWebuiUrl', 'napcatVersion', 'downloadProxy'],
      },
      { id: 'about', label: '关于', keys: ['checkUpdateOnStart'] },
    ]

    // 忘了归类的字段兜一层：进「其他」页，绝不出现在任何页都点不到的地方。
    const GROUPED_KEYS = new Set(GROUPS.reduce((all, g) => all.concat(g.keys), []))
    const UNGROUPED_KEYS = FIELDS.map((f) => f.key).filter((k) => !GROUPED_KEYS.has(k))
    if (UNGROUPED_KEYS.length > 0) GROUPS.push({ id: 'more', label: '其他', keys: UNGROUPED_KEYS })

    /**
     * 声音有两套，二选一：本地合成（edge / sherpa）与肥鱼声音服务。
     * 只显示选中那一套的字段 —— 两套混在一起列出来是「以后混乱」的根源。
     * 存储上仍然只有 `ttsProvider` 一个键（'edge' | 'sherpa' | 'feiyu'），老配置照旧。
     */
    const LOCAL_ONLY_KEYS = new Set(['ttsVoice', 'ttsRate', 'ttsPitch', 'ttsPythonPath', 'ttsSid', 'ttsSpeed', 'ttsModelDir'])
    const FEIYU_ONLY_KEYS = new Set([
      'feiyuBaseUrl',
      'feiyuApiKey',
      'feiyuVoice',
      'feiyuStyle',
      'feiyuTimeoutMs',
      'feiyuPollIntervalMs',
      'feiyuSingTimeoutMs',
      'voiceMaxSongChars',
    ])

    /** 当前是不是「肥鱼声音服务」那一套。 */
    function usesFeiyu(shown) {
      return String(shown?.ttsProvider ?? '') === 'feiyu'
    }

    function isIdList(kind) {
      return kind === 'list' || kind === 'group-list'
    }

    /** 结构化的字段（值是数组/对象，不是一段字符串）。 */
    function isStructured(kind) {
      return kind === 'model-chain' || kind === 'profiles'
    }

    /**
     * 目标标识归一化：只认 `group:<数字>` / `private:<数字>`。
     * 与宿主半的 `normalizeDestinationProfiles` 同一条规则；认不出返回空串。
     */
    function canonicalTarget(raw) {
      const text = String(raw ?? '').trim()
      if (!/^(group|private):\d{1,16}$/.test(text)) return ''
      return text
    }

    /** 目标的可读名：群名 / 备注 / 私聊号。 */
    function targetLabel(row) {
      const target = String(row?.target ?? '')
      const id = target.split(':')[1] ?? ''
      const name = String(row?.label ?? '').trim()
      if (name !== '') return `${name}（${target}）`
      return target.startsWith('group:') ? `群 ${id}` : `私聊 ${id}`
    }

    function splitIdText(raw) {
      return String(raw == null ? '' : raw)
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter((s) => s !== '')
    }

    /** 全角数字换成半角。对得上群号才返回，否则空串。和宿主的 normalizeGroupId 同一条规则。 */
    function canonicalGroupId(raw) {
      const id = String(raw ?? '')
        .trim()
        .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      return /^\d{1,16}$/.test(id) ? id : ''
    }

    /** 只接受我们自己拼出来的群头像地址，别的来源一律不当图片。 */
    function safeGroupAvatar(url) {
      const text = String(url ?? '').trim()
      const matched = text.match(/^https:\/\/p\.qlogo\.cn\/gh\/(\d{1,16})\/(\d{1,16})\/100$/)
      if (!matched || matched[1] !== matched[2]) return ''
      return text
    }

    /**
     * 群白名单每一行怎么显示。
     * 有群名才带头像；没有资料、或头像地址对不上，就只留用户填的群号。
     */
    function groupDisplayRows(raw, metas) {
      const byId = new Map()
      for (const item of Array.isArray(metas) ? metas : []) {
        if (!item || typeof item !== 'object') continue
        const id = String(item.id ?? '').trim()
        if (id === '') continue
        byId.set(id, {
          name: String(item.name ?? '').trim(),
          avatar: safeGroupAvatar(item.avatar),
        })
      }
      return splitIdText(raw).map((id) => {
        const key = canonicalGroupId(id) || id
        const meta = byId.get(key) || byId.get(id)
        const name = meta?.name || ''
        return { id, name, avatar: name !== '' ? meta?.avatar || '' : '' }
      })
    }

    function format(field, raw) {
      if (isIdList(field.kind)) return Array.isArray(raw) ? raw.join(', ') : raw == null ? '' : String(raw)
      if (field.kind === 'boolean') return raw === true
      if (field.kind === 'number') return raw == null || raw === '' ? '' : String(raw)
      // 口令类字段不进草稿：快照里有值也不回显、不参与“改没改过”的比较，
      // 编辑框留空就等于不动它（真要换口令得重新填一遍）。
      if (field.kind === 'secret') return ''
      // 结构化字段保留原值（数组），卡片按控件渲染；不要在草稿里做字符串化，
      // 否则「改了一行别的字段」会把结构悄悄写坏成一段文本。
      if (isStructured(field.kind)) return Array.isArray(raw) ? raw.map((x) => ({ ...x })) : []
      return raw == null ? '' : String(raw)
    }

    /** 表单值 → 要写进设置的 JSON；数字不合法返回 undefined（拦住保存）。 */
    function parse(field, raw) {
      if (isIdList(field.kind)) return splitIdText(raw)
      if (isStructured(field.kind)) return Array.isArray(raw) ? raw : []
      if (field.kind === 'boolean') return raw === true
      if (field.kind === 'number') {
        const text = String(raw ?? '').trim()
        // 清空输入框时浏览器给的是空串，Number('') === 0。不能把「留空」存成 0。
        if (text === '') return undefined
        const n = Number(text)
        return Number.isFinite(n) ? n : undefined
      }
      return String(raw == null ? '' : raw).trim()
    }

    function draftFrom(value) {
      const v = value && typeof value === 'object' ? value : {}
      const draft = {}
      for (const f of FIELDS) draft[f.key] = format(f, v[f.key])
      return draft
    }

    function same(a, b) {
      return JSON.stringify(a) === JSON.stringify(b)
    }

    /**
     * 会话下拉的选项：真实的会话列表 + “不驱动”+ 一个兜底项。
     *
     * **归档的会话不列出来**（用户报的 bug：下拉里混进了一堆早就归档的会话）——
     * 归档集在 workspace 域：`ctx.workspaces.list.getSnapshot().archivedSessionIds`。
     *
     * ⚠️ **TODO（下次修）：子代理会话也会被列进来。**
     * `SessionSummary` 上有 `origin?: 'subagent'` 与 `parentId?: SessionId`
     * （见 `@deepseek-ai/dsh-api-session-controller` 的 `SessionSummary`），据此可以剔除。
     * 剔除之后同样要给**当前选中项**兜底，规则与下面的归档处理一致 ——
     * 否则子代理会话是当前目标时，一保存就把目标会话清空。
     * 退化做法也可接受：把它们折叠进一个“显示子代理会话”的展开项，别一次铺开一长串。
     *
     * 两个兜底项都是必要的：
     * - 配置里那个 id 可能**不在**列表里（别的工作区、宿主还没加载完）；
     * - 也可能**正好是归档的**（用户刚把它归档了）。
     * 两种都必须保留成选项，否则用户一保存就把目标会话清空了。
     */
    function sessionOptions(state, current, archivedIds) {
      const archived = new Set((Array.isArray(archivedIds) ? archivedIds : []).map((id) => String(id)))
      const out = [{ value: '', label: '（不接到任何会话）' }]
      const ids = Array.isArray(state?.ids) ? state.ids : []
      const byId = state && typeof state.byId === 'object' && state.byId ? state.byId : {}
      const cur = String(current ?? '')
      const seen = new Set([''])
      for (const id of ids) {
        const key = String(id)
        const isArchived = archived.has(key)
        // 归档的一律不显示 —— 除非它就是当前选中的那个（不显示的话就没法保留/换掉了）
        if (isArchived && key !== cur) continue
        seen.add(key)
        const row = byId[id] ?? {}
        const title = typeof row.displayTitle === 'string' && row.displayTitle !== '' ? row.displayTitle : key
        out.push({
          value: key,
          label: `${title}${row.running ? '（运行中）' : ''}${isArchived ? '（已归档）' : ''}`,
        })
      }
      if (cur !== '' && !seen.has(cur)) {
        out.push({ value: cur, label: `${cur}（${archived.has(cur) ? '已归档' : '不在会话列表里'}）` })
      }
      return out
    }

    /** 没有 sessions / workspaces 服务（或它们还没就绪）时用的稳定空快照 —— 必须稳定，否则 useSyncExternalStore 会死循环。 */
    const EMPTY_SESSION_LIST = { ids: [], byId: {} }
    const EMPTY_WORKSPACES = { archivedSessionIds: [] }

    // ── 样式（内联，跟随主题文字色） ──────────────────────────────────────────
    const BORDER = '1px solid rgba(127,127,127,0.35)'
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '10px' },
      head: { display: 'flex', flexDirection: 'column', gap: '2px' },
      title: { fontSize: '14px', fontWeight: 600 },
      sub: { fontSize: '12px', opacity: 0.65, lineHeight: 1.5 },
      grid: { display: 'grid', gridTemplateColumns: 'minmax(120px, 180px) 1fr', gap: '8px 12px', alignItems: 'start' },
      label: { fontSize: '13px', paddingTop: '5px' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '5px 8px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '13px',
      },
      hint: { fontSize: '11px', opacity: 0.55, marginTop: '3px', lineHeight: 1.5 },
      check: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', paddingTop: '4px' },
      foot: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      btn: {
        padding: '5px 14px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '13px',
      },
      primary: { background: 'rgba(127,127,127,0.18)', fontWeight: 600 },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '8px 10px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'left',
      },
      chevron: { marginLeft: 'auto', opacity: 0.6 },
      note: { fontSize: '12px', opacity: 0.7 },
      err: { fontSize: '12px', color: '#e5534b' },
      overridden: { fontSize: '11px', opacity: 0.5, marginLeft: '4px' },
      // “撤销覆盖”：与“·已覆盖”并排的小按钮。文案本身就是动作，不加图标。
      link: {
        marginLeft: '4px',
        padding: '0 4px',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        opacity: 0.75,
        textDecoration: 'underline',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '11px',
      },
      ops: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      groupList: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        marginTop: '8px',
        maxHeight: '240px',
        overflowY: 'auto',
      },
      groupRow: { display: 'flex', alignItems: 'center', gap: '8px', minHeight: '28px' },
      groupAvatar: {
        width: '28px',
        height: '28px',
        borderRadius: '6px',
        objectFit: 'cover',
        flex: '0 0 auto',
        background: 'rgba(127,127,127,0.15)',
      },
      groupText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
      groupName: { fontSize: '13px', lineHeight: 1.3 },
      groupId: { fontSize: '11px', opacity: 0.55, lineHeight: 1.3 },
      groupIdOnly: { fontSize: '13px', lineHeight: 1.3 },
      // 结构化编辑器（模型优先级 / 每目标设置）
      structBox: { display: 'flex', flexDirection: 'column', gap: '8px' },
      chainRow: { display: 'flex', alignItems: 'center', gap: '6px' },
      chainIndex: { fontSize: '11px', opacity: 0.55, width: '14px', textAlign: 'right', flex: '0 0 auto' },
      miniBtn: {
        padding: '2px 8px',
        borderRadius: '5px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1.4,
        flex: '0 0 auto',
      },
      profileCard: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '10px',
        borderRadius: '6px',
        border: BORDER,
      },
      profileHead: { display: 'flex', alignItems: 'center', gap: '8px' },
      profileName: { fontSize: '13px', fontWeight: 600, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' },
      profileGrid: { display: 'grid', gridTemplateColumns: 'minmax(96px, 130px) 1fr', gap: '6px 10px', alignItems: 'start' },
      profileLabel: { fontSize: '12px', opacity: 0.7, paddingTop: '6px' },
      // 分类页签：一排能点的小标签，当前页描边加深
      tabs: { display: 'flex', gap: '6px', flexWrap: 'wrap', paddingBottom: '2px' },
      tab: {
        padding: '4px 10px',
        borderRadius: '999px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1.5,
      },
      tabActive: { background: 'rgba(127,127,127,0.18)', fontWeight: 600 },
      // 声音二选一：两块并排，选中的那块描边加重
      choice: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
      choiceCard: {
        flex: '1 1 180px',
        textAlign: 'left',
        padding: '8px 10px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '13px',
      },
      choiceOn: { background: 'rgba(127,127,127,0.16)', fontWeight: 600 },
      choiceDesc: { display: 'block', fontSize: '11px', opacity: 0.6, marginTop: '3px', fontWeight: 400 },
      // 左下角入口：侧栏脚部那个小按钮，跟 Settings 挨着
      footEntry: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '6px 10px',
        borderRadius: '6px',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '13px',
        textAlign: 'left',
      },
      footEntryIcon: { fontSize: '14px', lineHeight: 1, opacity: 0.85 },
      // 面板浮层：铺满窗口，中间一块可滚动的设置面板
      overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 2147483000,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '40px 16px',
        overflow: 'auto',
      },
      sheet: {
        width: 'min(760px, 100%)',
        maxHeight: 'calc(100vh - 80px)',
        overflow: 'auto',
        borderRadius: '10px',
        border: BORDER,
        background: 'var(--dsh-bg-elevated, #fff)',
        color: 'inherit',
        boxShadow: '0 16px 48px rgba(0,0,0,0.28)',
        padding: '4px 14px 14px',
      },
      sheetHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0 6px' },
      sheetTitle: { fontSize: '14px', fontWeight: 600 },
    }

    function disabled(btn, off) {
      return off ? { ...btn, opacity: 0.5, cursor: 'default' } : btn
    }

    // ── 卡片 ──────────────────────────────────────────────────────────────────

    function Card(props) {
      const scope = props.scope
      const subscribe = react.useCallback((cb) => scope.subscribe(cb), [scope])
      const getSnapshot = react.useCallback(() => scope.getSnapshot(), [scope])
      const snap = react.useSyncExternalStore(subscribe, getSnapshot)

      const [draft, setDraft] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')
      const [note, setNote] = react.useState('')
      // 默认展开：字段直接可见。标题仍可收起。
      const [open, setOpen] = react.useState(true)
      // 当前看的是哪一页（分类页签）。默认第一页，避免一打开就是空的。
      const [activeGroup, setActiveGroup] = react.useState(GROUPS[0]?.id ?? 'more')
      // NapCat 的三个操作按钮：展开时拉一次接口；拿不到就保持 null（按钮禁用）。
      const [napcat, setNapcat] = react.useState(null)
      const [napcatBusy, setNapcatBusy] = react.useState('')
      const [pluginVersion, setPluginVersion] = react.useState('')
      const [versionState, setVersionState] = react.useState('loading')
      const [updateBusy, setUpdateBusy] = react.useState(false)
      const [updateKind, setUpdateKind] = react.useState('')
      const [updateOffer, setUpdateOffer] = react.useState(null)
      const [updateNote, setUpdateNote] = react.useState('')
      const [updateIsError, setUpdateIsError] = react.useState(false)
      // 群白名单旁边的群名和头像。拿不到就空着，输入框照常能改、能保存。
      const [groupMetas, setGroupMetas] = react.useState([])
      // 下拉用的清单：提供商 / 模型 / 预设。拿不到就退化成「手写 provider/model」。
      const [catalog, setCatalog] = react.useState(null)
      const [catalogNote, setCatalogNote] = react.useState('')
      // 已知的 QQ 目的地（群 / 私聊），给「每个群/私聊单独设置」做候选。
      const [targets, setTargets] = react.useState([])

      const current = react.useMemo(() => draftFrom(snap.value), [snap.value])
      const shown = draft ?? current
      const dirty = draft !== null && !same(draft, current)
      const user = snap.user && typeof snap.user === 'object' ? snap.user : {}

      // ── 目标会话的下拉数据源 ──────────────────────────────────────────────
      // ctx.sessions.list 是客户端 SDK 暴露的会话列表快照（ObservableSnapshot）。
      // 取不到（这个部署没装 sessions 服务、或它还没就绪）就退回“只有兜底项”，
      // 卡片本身照常渲染 —— 宁可少一个下拉，也不要整张卡片消失。
      const sessions = props.sessionsOf ? props.sessionsOf() : undefined
      const listStore = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list : undefined
      const listSubscribe = react.useCallback((cb) => (listStore ? listStore.subscribe(cb) : () => {}), [listStore])
      const listGetSnapshot = react.useCallback(
        () => (listStore ? listStore.getSnapshot() : EMPTY_SESSION_LIST),
        [listStore],
      )
      const sessionList = react.useSyncExternalStore(listSubscribe, listGetSnapshot)
      react.useEffect(() => {
        // 进卡片时拉一次，免得显示的是很久以前的标题
        if (sessions && typeof sessions.refresh === 'function') Promise.resolve(sessions.refresh()).catch(() => {})
      }, [sessions])

      // 归档集在 workspace 域：ctx.workspaces.list 的快照里有 archivedSessionIds
      //（“Complete registry-global archive set”）。取不到就当作“没有归档的会话”——
      // 宁可多列几个，也别把用户能选的会话藏掉。
      const workspaces = props.workspacesOf ? props.workspacesOf() : undefined
      const wsStore =
        workspaces && workspaces.list && typeof workspaces.list.getSnapshot === 'function' ? workspaces.list : undefined
      const wsSubscribe = react.useCallback((cb) => (wsStore && typeof wsStore.subscribe === 'function' ? wsStore.subscribe(cb) : () => {}), [wsStore])
      const wsGetSnapshot = react.useCallback(() => {
        if (!wsStore) return EMPTY_WORKSPACES
        try {
          return wsStore.getSnapshot() ?? EMPTY_WORKSPACES
        } catch {
          return EMPTY_WORKSPACES
        }
      }, [wsStore])
      const workspaceSnapshot = react.useSyncExternalStore(wsSubscribe, wsGetSnapshot)

      // 群白名单的群名和头像。失败就清空，输入框不禁用，保存也不等这次请求。
      const groupListText = String(shown.groupWhitelist ?? '')
      react.useEffect(() => {
        if (!open) return undefined
        const ids = splitIdText(groupListText)
        if (ids.length === 0) {
          setGroupMetas([])
          return undefined
        }
        let alive = true
        const timer = setTimeout(() => {
          if (typeof fetch !== 'function') return
          fetch(`${GROUP_META_API}?ids=${encodeURIComponent(ids.join(','))}`, {
            credentials: 'include',
            headers: { accept: 'application/json' },
          })
            .then((res) => res.json().catch(() => null))
            .then((body) => {
              if (!alive) return
              if (body && body.ok === true && Array.isArray(body.groups)) setGroupMetas(body.groups)
              else setGroupMetas([])
            })
            .catch(() => {
              if (alive) setGroupMetas([])
            })
        }, 300)
        return () => {
          alive = false
          clearTimeout(timer)
        }
      }, [open, groupListText])

      // 下拉清单（提供商/模型/预设）与已知目的地。都是只读辅助数据：
      // 拿不到时卡片照常能编辑 —— 退化成手写 provider/model，或者只显示已有的行。
      react.useEffect(() => {
        if (!open || typeof fetch !== 'function') return undefined
        let alive = true
        const pull = () => {
          fetch(CATALOG_API, { credentials: 'include', headers: { accept: 'application/json' } })
            .then((res) => res.json().catch(() => null))
            .then((body) => {
              if (!alive) return
              if (body && body.ok === true) {
                setCatalog({
                  providers: Array.isArray(body.providers) ? body.providers : [],
                  presets: Array.isArray(body.presets) ? body.presets : [],
                  defaultModel: body.defaultModel ?? null,
                  defaultDir: typeof body.defaultDir === 'string' ? body.defaultDir : '',
                  // 肥鱼音色清单：宿主半探测声音服务得来。拿不到就留空，
                  // 渲染时退回字段自带的静态 options，下拉不会空掉。
                  feiyuVoices: body.feiyuVoices && typeof body.feiyuVoices === 'object' ? body.feiyuVoices : null,
                })
                const errors = Array.isArray(body.errors) ? body.errors : []
                setCatalogNote(errors.length > 0 ? `部分清单没读到：${errors[0]}` : '')
              } else {
                setCatalog(null)
                setCatalogNote('读不到模型清单，这一栏只能手写 provider/model。')
              }
            })
            .catch(() => {
              if (!alive) return
              setCatalog(null)
              setCatalogNote('读不到模型清单（本机接口没响应），这一栏只能手写 provider/model。')
            })
        }
        pull()
        const timer = setInterval(pull, 15000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [open])

      react.useEffect(() => {
        if (!open || typeof fetch !== 'function') return undefined
        let alive = true
        const pull = () => {
          fetch(PROFILES_API, { credentials: 'include', headers: { accept: 'application/json' } })
            .then((res) => res.json().catch(() => null))
            .then((body) => {
              if (!alive) return
              setTargets(body && body.ok === true && Array.isArray(body.targets) ? body.targets : [])
            })
            .catch(() => {
              if (alive) setTargets([])
            })
        }
        pull()
        const timer = setInterval(pull, 20000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [open])

      /**
       * 拉一次 NapCat 状态（WebUI 地址 + 是否在运行）。
       * 没有 fetch 或响应不是 ok:true 时返回 undefined，调用方保持上一次的状态。
       */
      async function fetchNapcat() {
        if (typeof fetch !== 'function') return undefined
        const res = await fetch(NAPCAT_API, { credentials: 'include', headers: { accept: 'application/json' } })
        const body = await res.json().catch(() => ({}))
        return body && body.ok === true ? body : undefined
      }

      // 展开卡片时读一次 NapCat 状态，之后每 5 秒轮询一次。
      // 轮询用于识别外部启动：用户在别处手动跑了 bat 时，只有重新拉取才能把按钮改成“已在运行”。
      // 卡片收起或组件卸载时清掉定时器，不让它在后台一直跑。
      react.useEffect(() => {
        if (!open) return undefined
        let alive = true
        if (typeof fetch !== 'function') return undefined
        fetch(UPDATE_API, { credentials: 'include', headers: { accept: 'application/json' } })
          .then((res) => res.json().catch(() => null))
          .then((body) => {
            if (!alive) return
            if (body && body.ok === true && body.current) {
              setPluginVersion(String(body.current))
              setVersionState('ready')
              return
            }
            setVersionState('missing')
          })
          .catch(() => {
            // 读不到版本就留一句白话，不把异常原文摆出来。
            if (alive) setVersionState('missing')
          })
        return () => {
          alive = false
        }
      }, [open])

      function plainUpdateText(value, ok) {
        const text = String(value ?? '').trim()
        if (text === '') return ok ? '检查完成。' : '检查更新失败，稍后再试。'
        if (!ok && (/TypeError|fetch failed|ECONN|ENOTFOUND|API rate limit/i.test(text) || /\n\s+at /.test(text))) {
          if (/rate limit/i.test(text)) return 'GitHub 限流了，等一会儿再点「检查更新」。'
          return '连不上 GitHub，这次没有检查到更新。稍后再试。'
        }
        return text
      }

      async function checkForUpdate() {
        setUpdateKind('check')
        setUpdateBusy(true)
        setUpdateNote('')
        setUpdateIsError(false)
        setUpdateOffer(null)
        try {
          if (typeof fetch !== 'function') {
            setUpdateIsError(true)
            setUpdateNote('这个页面没有网络接口，检查不了更新。')
            return
          }
          const res = await fetch(UPDATE_API, {
            method: 'POST',
            credentials: 'include',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: '{}',
          })
          const body = await res.json().catch(() => null)
          if (!body || typeof body !== 'object') {
            setUpdateIsError(true)
            setUpdateNote('检查更新没有返回能看懂的结果。稍后再试。')
            return
          }
          if (body.current) setPluginVersion(String(body.current))
          const ok = body.ok === true
          setUpdateIsError(!ok)
          setUpdateNote(plainUpdateText(ok ? body.message : body.error, ok))
          const tag = typeof body.tag === 'string' ? body.tag : ''
          const version = typeof body.latest === 'string' ? body.latest : ''
          if (ok && body.updateAvailable === true && tag !== '' && version !== '') {
            setUpdateOffer({ tag, version })
          }
        } catch {
          setUpdateIsError(true)
          setUpdateNote('连不上本机的检查更新接口。确认 dsh-web 在跑，稍后再试。')
        } finally {
          setUpdateBusy(false)
          setUpdateKind('')
        }
      }

      async function applyUpdate() {
        if (!updateOffer) return
        const version = updateOffer.version
        const tag = updateOffer.tag
        setUpdateKind('apply')
        setUpdateBusy(true)
        setUpdateNote('')
        setUpdateIsError(false)
        try {
          if (typeof fetch !== 'function') {
            setUpdateIsError(true)
            setUpdateNote('这个页面没有网络接口，装不了更新。')
            return
          }
          const res = await fetch(UPDATE_API, {
            method: 'POST',
            credentials: 'include',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'apply', version }),
          })
          const body = await res.json().catch(() => null)
          if (!body || typeof body !== 'object') {
            setUpdateIsError(true)
            setUpdateNote('更新没有返回能看懂的结果。稍后再试。')
            return
          }
          const ok = body.ok === true
          setUpdateIsError(!ok)
          setUpdateNote(plainUpdateText(ok ? body.message : body.error, ok))
          if (ok) setUpdateOffer(null)
        } catch {
          setUpdateIsError(true)
          setUpdateNote(`更新到 ${tag} 的请求没返回。如果面板马上断开，多半是正在重启，请稍后刷新；登录口令可能会变。如果还是旧版本，再点一次。`)
        } finally {
          setUpdateBusy(false)
          setUpdateKind('')
        }
      }

      react.useEffect(() => {
        if (!open) return undefined
        let alive = true
        const pull = () => {
          fetchNapcat()
            .then((body) => {
              if (alive && body !== undefined) setNapcat(body)
            })
            .catch(() => {
              // 单次失败保留上一次的状态：轮询会再试，不给按钮闪一下禁用。
            })
        }
        pull()
        const timer = setInterval(pull, 5000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [open])

      /** 两个 POST 按钮共用：动作没成（ok:false）也把宿主的 error 原文显示出来。 */
      async function postNapcat(action, okNote) {
        setNapcatBusy(action)
        setError('')
        setNote('')
        try {
          if (typeof fetch !== 'function') throw new Error('这个环境没有 fetch')
          // 显式声明 JSON：宿主接口对**带请求体**的 POST 只认 application/json。
          // 这两个动作本身没有请求体，服务端也放行无体的 POST —— 那条是给还没刷新的旧 bundle 兜底。
          const res = await fetch(`${NAPCAT_API}/${action}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(String(body?.error || `HTTP ${res.status}`))
          setNote(String(body?.message || okNote))
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setNapcatBusy('')
          // 成功或失败都重拉一次：启动成功后按钮要立刻变“已在运行”，
          // 被宿主拒绝（例如已在运行）时也要把真实状态显示出来。
          try {
            const fresh = await fetchNapcat()
            if (fresh !== undefined) setNapcat(fresh)
          } catch {
            // 拉取失败时保留上一次的状态
          }
        }
      }

      function change(key) {
        return (event) => {
          const next = { ...shown }
          next[key] = event.target.type === 'checkbox' ? event.target.checked : event.target.value
          setDraft(next)
          setNote('')
          setError('')
        }
      }

      /** 结构化字段的统一改写：拿到新数组就整段替换。 */
      function setStructured(key, list) {
        const next = { ...shown }
        next[key] = list
        setDraft(next)
        setNote('')
        setError('')
      }

      /**
       * 声音模块：二选一。
       *
       * 原来是三选一的下拉，本地那套（edge / sherpa）和肥鱼那套的设置项全铺在一页上，
       * 看着像两个模块各管各的，容易配混。这里拆成两组卡片：
       * - 本地合成：edge / sherpa，共用一个选区（都是本机 python 出来的声音）；
       * - 肥鱼声音服务：本机 9880 那个服务。
       * 选哪组就只显示哪组的字段，另一组的键值不会被清空。
       */
      function renderVoiceModule(field, cur) {
        const value = String(cur ?? '')
        const localOn = value === 'edge' || value === 'sherpa'
        const feiyuOn = value === 'feiyu'

        const pick = (next) => () => {
          if (!snap.writable || busy) return
          const draftNext = { ...shown }
          draftNext[field.key] = next
          setDraft(draftNext)
          setNote('')
          setError('')
        }

        // 本地那组再分 edge / sherpa —— 两种都在本机跑，但用的引擎不同。
        const localEngine = (engine, label, desc) =>
          h(
            'button',
            {
              key: engine,
              type: 'button',
              style: { ...S.choiceCard, ...(value === engine ? S.choiceOn : {}) },
              disabled: !snap.writable || busy,
              onClick: pick(engine),
            },
            label,
            h('span', { style: S.choiceDesc }, desc),
          )

        return h(
          'div',
          null,
          h(
            'div',
            { style: S.choice },
            h(
              'div',
              { style: { ...S.choiceCard, ...(localOn ? S.choiceOn : {}) } },
              h(
                'div',
                { style: { fontWeight: 600, marginBottom: '6px' } },
                '本地合成',
                h('span', { style: S.choiceDesc }, '声音在本机算，不联网'),
              ),
              h(
                'div',
                { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                localEngine('edge', 'edge-tts', '微软的语音，靠本机 python 跑'),
                localEngine('sherpa', 'sherpa', '本地离线模型，最稳'),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.choiceCard, ...(feiyuOn ? S.choiceOn : {}) },
                disabled: !snap.writable || busy,
                onClick: pick('feiyu'),
              },
              '肥鱼声音服务',
              h('span', { style: S.choiceDesc }, '本机 9880 那个服务，声音更像人，也能唱歌'),
            ),
          ),
        )
      }

      /**
       * 肥鱼音色的下拉。
       *
       * 清单来源按优先级：
       * 1. catalog 里宿主半探测到的 `feiyuVoices.voices`（声音服务在线时的真实注册音色）；
       * 2. 探测不到（服务没起 / 口令不对 / 本机接口没响应）→ 字段自带的静态 `options`。
       * 两条都兜住当前值：配置里那个 id 若不在清单里，必须留成选项，
       * 否则用户一保存就把音色清空了。
       */
      function renderFeiyuVoice(field, cur) {
        const probed = catalog?.feiyuVoices
        const probedVoices = Array.isArray(probed?.voices) ? probed.voices : []
        const pairs = []
        const seen = new Set()
        const pushOption = (value, label) => {
          const v = String(value ?? '').trim()
          if (v === '' || seen.has(v)) return
          seen.add(v)
          pairs.push([v, label])
        }
        if (probedVoices.length > 0) {
          for (const row of probedVoices) {
            const id = String(row?.id ?? '').trim()
            if (id === '') continue
            const styles = Array.isArray(row?.styles) ? row.styles.filter((x) => String(x ?? '').trim() !== '') : []
            const tags = []
            if (row?.kind === 'rvc') tags.push('换声')
            if (styles.length > 0) tags.push(`语气 ${styles.map(String).join(' / ')}`)
            if (row?.available === false) tags.push('当前不可用')
            pushOption(id, tags.length > 0 ? `${id}（${tags.join('，')}）` : id)
          }
        } else {
          for (const pair of field.options || []) pushOption(pair[0], pair[1])
        }
        // 宿主半没探测成功时会给一条 note（连不上 / 口令不对 / 没注册音色）。
        // 有话就说，但不要把它做成报错 —— 下拉本身照常可用。
        const note = String(probed?.note ?? '').trim()

        return h(
          'div',
          null,
          h(
            'select',
            { style: S.input, value: cur, disabled: !snap.writable || busy, onChange: change(field.key) },
            [
              ...pairs.map(([v, text]) => h('option', { key: v, value: v }, text)),
              ...(cur !== '' && !seen.has(cur)
                ? [h('option', { key: '__current', value: cur }, `${cur}（当前值，不在清单里）`)]
                : []),
            ],
          ),
          note !== '' ? h('div', { style: S.hint }, note) : null,
        )
      }

      /**
       * 模型优先级链编辑器：一行一个模型，带上下移动与删除，末尾是「加一个」。
       *
       * 为什么不用一句话（逗号分隔）输入：顺序就是语义，拖错的代价是切错模型；
       * 而且每个条目都得从已配置的 provider/model 里挑 —— 手写 id 一定会打错。
       */
      function renderModelChain(field, list) {
        const providers = catalog?.providers ?? []
        const options = []
        for (const p of providers) for (const m of p.models) options.push([`${p.id}/${m.id}`, `${p.name || p.id} · ${m.name || m.id}`])
        const rows = list.map((ref, index) => {
          const value = String(ref ?? '')
          const known = options.some(([v]) => v === value)
          const move = (delta) => {
            const target = index + delta
            if (target < 0 || target >= list.length) return
            const next = list.slice()
            const [item] = next.splice(index, 1)
            next.splice(target, 0, item)
            setStructured(field.key, next)
          }
          return h(
            'div',
            { key: `${index}-${value}`, style: S.chainRow },
            h('span', { style: S.chainIndex }, String(index + 1)),
            options.length > 0
              ? h(
                  'select',
                  {
                    style: { ...S.input, flex: '1 1 auto' },
                    value: known ? value : '',
                    disabled: !snap.writable || busy,
                    onChange: (event) => {
                      const next = list.slice()
                      next[index] = event.target.value
                      setStructured(field.key, next)
                    },
                  },
                  [
                    h('option', { key: '(none)', value: '' }, '（选一个模型）'),
                    ...options.map(([v, text]) => h('option', { key: v, value: v }, text)),
                    ...(!known && value !== ''
                      ? [h('option', { key: '__current', value }, `${value}（当前值，不在清单里）`)]
                      : []),
                  ],
                )
              : h('input', {
                  type: 'text',
                  style: { ...S.input, flex: '1 1 auto' },
                  value,
                  placeholder: 'provider/model',
                  disabled: !snap.writable || busy,
                  onChange: (event) => {
                    const next = list.slice()
                    next[index] = event.target.value
                    setStructured(field.key, next)
                  },
                  spellCheck: false,
                }),
            h('button', {
              type: 'button',
              title: '往上挪',
              style: disabled(S.miniBtn, busy || !snap.writable || index === 0),
              disabled: busy || !snap.writable || index === 0,
              onClick: () => move(-1),
            }, '↑'),
            h('button', {
              type: 'button',
              title: '往下挪',
              style: disabled(S.miniBtn, busy || !snap.writable || index === list.length - 1),
              disabled: busy || !snap.writable || index === list.length - 1,
              onClick: () => move(1),
            }, '↓'),
            h('button', {
              type: 'button',
              title: '从优先级里去掉',
              style: disabled(S.miniBtn, busy || !snap.writable),
              disabled: busy || !snap.writable,
              onClick: () => setStructured(field.key, list.filter((_x, i) => i !== index)),
            }, '✕'),
          )
        })
        const canAdd = list.length < 8
        return h(
          'div',
          { style: S.structBox },
          rows,
          h(
            'div',
            { style: S.ops },
            h(
              'button',
              {
                type: 'button',
                style: disabled(S.btn, busy || !snap.writable || !canAdd),
                disabled: busy || !snap.writable || !canAdd,
                onClick: () => setStructured(field.key, [...list, '']),
              },
              canAdd ? '加一个模型' : '最多 8 个',
            ),
            list.length === 0 ? h('span', { style: S.hint }, '留空 = 不启用优先级链。') : null,
          ),
          catalogNote ? h('div', { style: S.hint }, catalogNote) : null,
        )
      }

      /**
       * 每个群 / 私聊的个性化设置编辑器。
       *
       * 一行 = 一个目的地。用户要的四件事都在这一行里：
       * 休眠时段、24 小时实时回复、连着发时等多久、多久没新消息就停止跟随。
       * 目的地候选来自宿主半扫出来的已知群/私聊，也可以手填 `group:群号`。
       */
      function renderProfiles(field, list) {
        const knownTargets = new Set((Array.isArray(targets) ? targets : []).map((t) => String(t.target)))
        const update = (index, patch) => {
          const next = list.map((row, i) => (i === index ? { ...row, ...patch } : row))
          setStructured(field.key, next)
        }
        const rows = list.map((row, index) => {
          const target = String(row?.target ?? '')
          const candidates = (Array.isArray(targets) ? targets : []).filter(
            (t) => t.target === target || !list.some((r) => r?.target === t.target),
          )
          return h(
            'div',
            { key: `${index}-${target}`, style: S.profileCard },
            h(
              'div',
              { style: S.profileHead },
              h('span', { style: S.profileName }, targetLabel(row)),
              h(
                'button',
                {
                  type: 'button',
                  title: '删掉这一行',
                  style: disabled(S.miniBtn, busy || !snap.writable),
                  disabled: busy || !snap.writable,
                  onClick: () => setStructured(field.key, list.filter((_x, i) => i !== index)),
                },
                '✕',
              ),
            ),
            h(
              'div',
              { style: S.profileGrid },
              h('span', { style: S.profileLabel }, '目的地'),
              h(
                'div',
                null,
                candidates.length > 0
                  ? h(
                      'select',
                      {
                        style: S.input,
                        value: knownTargets.has(target) ? target : '',
                        disabled: !snap.writable || busy,
                        onChange: (event) => update(index, { target: event.target.value }),
                      },
                      [
                        h('option', { key: '(none)', value: '' }, '（选一个群或私聊）'),
                        ...candidates.map((t) =>
                          h(
                            'option',
                            { key: t.target, value: t.target },
                            `${t.target.startsWith('group:') ? '群' : '私聊'} ${t.target.split(':')[1]}${t.label ? ` · ${t.label}` : ''}`,
                          ),
                        ),
                        ...(target !== '' && !knownTargets.has(target)
                          ? [h('option', { key: '__current', value: target }, `${target}（手填，不在已知列表里）`)]
                          : []),
                      ],
                    )
                  : h('input', {
                      type: 'text',
                      style: S.input,
                      value: target,
                      placeholder: 'group:群号 或 private:QQ号',
                      disabled: !snap.writable || busy,
                      onChange: (event) => update(index, { target: event.target.value }),
                      spellCheck: false,
                    }),
              ),
              h('span', { style: S.profileLabel }, '备注名'),
              h('input', {
                type: 'text',
                style: S.input,
                value: String(row?.label ?? ''),
                placeholder: '只用来认人，可以留空',
                disabled: !snap.writable || busy,
                onChange: (event) => update(index, { label: event.target.value }),
                spellCheck: false,
              }),
              h('span', { style: S.profileLabel }, '休眠时段'),
              h(
                'div',
                null,
                h('input', {
                  type: 'text',
                  style: S.input,
                  value: String(row?.quietHours ?? ''),
                  placeholder: '23:00-08:00（留空 = 不休眠）',
                  disabled: !snap.writable || busy || row?.alwaysReply === true,
                  onChange: (event) => update(index, { quietHours: event.target.value }),
                  spellCheck: false,
                }),
                row?.alwaysReply === true
                  ? h('div', { style: S.hint }, '已开「24 小时实时回复」，休眠时段不生效。')
                  : null,
              ),
            ),
            h(
              'div',
              { style: S.ops },
              h(
                'label',
                { style: S.check },
                h('input', {
                  type: 'checkbox',
                  checked: row?.alwaysReply === true,
                  disabled: !snap.writable || busy,
                  onChange: (event) => update(index, { alwaysReply: event.target.checked }),
                }),
                h('span', null, '24 小时实时回复（不受休眠时段限制）'),
              ),
            ),
            h(
              'div',
              { style: S.profileGrid },
              h('span', { style: S.profileLabel }, '连着发时等多久'),
              h(
                'div',
                null,
                h('input', {
                  type: 'number',
                  style: S.input,
                  value: String(row?.burstWaitMs ?? 0),
                  disabled: !snap.writable || busy,
                  onChange: (event) => update(index, { burstWaitMs: Number(event.target.value) || 0 }),
                }),
                h('div', { style: S.hint }, '毫秒。对方停手这么久才回，0 = 立刻回。'),
              ),
              h('span', { style: S.profileLabel }, '多久没消息就停止跟随'),
              h(
                'div',
                null,
                h('input', {
                  type: 'number',
                  style: S.input,
                  value: String(row?.idlePauseMs ?? 120000),
                  disabled: !snap.writable || busy,
                  onChange: (event) => update(index, { idlePauseMs: Number(event.target.value) || 0 }),
                }),
                h('div', { style: S.hint }, '毫秒。默认 120000 = 2 分钟。'),
              ),
            ),
          )
        })
        return h(
          'div',
          { style: S.structBox },
          rows,
          h(
            'div',
            { style: S.ops },
            h(
              'button',
              {
                type: 'button',
                style: disabled(S.btn, busy || !snap.writable),
                disabled: busy || !snap.writable,
                onClick: () =>
                  setStructured(field.key, [
                    ...list,
                    { target: '', label: '', quietHours: '', alwaysReply: false, burstWaitMs: 0, idlePauseMs: 120000 },
                  ]),
              },
              '加一个群 / 私聊',
            ),
            h(
              'button',
              {
                type: 'button',
                style: disabled(S.btn, busy || !snap.writable),
                disabled: busy || !snap.writable,
                onClick: () =>
                  setStructured(field.key, [
                    ...list,
                    { target: '', label: '', quietHours: '', alwaysReply: true, burstWaitMs: 0, idlePauseMs: 120000 },
                  ]),
              },
              '加一个「随叫随到」私聊',
            ),
            h('span', { style: S.hint }, '没列出来的群 / 私聊按上面的全局设置走。'),
          ),
        )
      }

      async function save() {
        setBusy(true)
        setError('')
        setNote('')
        try {
          const writes = []
          for (const f of FIELDS) {
            if (same(current[f.key], shown[f.key])) continue
            // 口令类：留空 = 保持原样。不然「打开卡片顺手点保存」就会把存着的口令清掉。
            if (f.kind === 'secret' && String(shown[f.key] ?? '') === '') continue
            const next = parse(f, shown[f.key])
            if (next === undefined) {
              const blank = f.kind === 'number' && String(shown[f.key] ?? '').trim() === ''
              throw new Error(
                blank
                  ? `「${f.label}」留空不会当成 0。想恢复默认请点撤销覆盖。`
                  : `「${f.label}」不是合法数字`,
              )
            }
            writes.push([f.key, next])
          }
          for (const [key, value] of writes) await scope.set(key, value)
          setDraft(null)
          setNote(writes.length === 0 ? '没有改动' : `已保存 ${writes.length} 项`)
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      /**
       * 撤销一个字段的本机覆盖。
       *
       * 设置读取优先级是“设置文件 > composition config”。卡片只发 set 时，
       * 用户从插件配置页改的值会被设置文件里的旧值盖住，且没有地方撤销。
       * 这里走设置源的 unset：清掉那一项，该键回落到 composition config 的值，
       * 刷新后“·已覆盖”标记消失。
       */
      async function unsetOverride(key) {
        const field = FIELDS.find((f) => f.key === key)
        setBusy(true)
        setError('')
        setNote('')
        try {
          if (typeof scope.unset !== 'function') throw new Error('这个设置源不支持撤销覆盖')
          await scope.unset(key)
          setDraft(null)
          setNote(`已撤销「${field ? field.label : key}」的本机覆盖`)
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      if (snap.status === 'loading') {
        return h('div', { style: S.wrap }, h('div', { style: S.sub }, '载入设置中…'))
      }
      if (snap.status === 'unavailable') {
        return h(
          'div',
          { style: S.wrap },
          h('div', { style: S.title }, 'QQ 桥接 Neko'),
          h(
            'div',
            { style: S.sub },
            '这个部署没有为 qq-bridge-neko 提供可写的设置服务（settings 提供者没挂载，或连接处于内存模式）。',
          ),
          h(
            'div',
            { style: S.hint },
            '宿主的两条设置通道都没拿到：插件配置表单（DSH 0.2.0 的 #677 迁移未完成）与本插件的本机设置接口。',
          ),
          h(
            'div',
            { style: S.hint },
            '先看诊断里「本机接口」那项：若宿主没有 webServer 服务，接口挂不上（此时仍可点右上角「打开配置文件」，改 profile 的 cordis.patch.yml 里 `- id: qq-bridge-neko` 的 config 后重启）。',
          ),
          h(
            'div',
            { style: S.hint },
            `诊断：${typeof scope.detail === 'function' ? scope.detail() : '（无诊断信息）'}`,
          ),
        )
      }

      // 只看当前这一页的字段。声音那一页还要按二选一筛掉另一套。
      const activeKeys = new Set(
        (GROUPS.find((g) => g.id === activeGroup) ?? GROUPS[0] ?? { keys: [] }).keys,
      )
      const feiyu = usesFeiyu(shown)
      const rows = []
      for (const f of FIELDS) {
        if (!activeKeys.has(f.key)) continue
        // 声音二选一：选了肥鱼就藏本地那套字段，反之亦然。
        // 藏起来只是不显示，值仍原样留在配置里 —— 切回去还在。
        if (feiyu && LOCAL_ONLY_KEYS.has(f.key)) continue
        if (!feiyu && FEIYU_ONLY_KEYS.has(f.key)) continue
        const value = shown[f.key]
        const overridden = Object.prototype.hasOwnProperty.call(user, f.key)
        let control
        if (f.kind === 'boolean') {
          control = h(
            'label',
            { style: S.check },
            h('input', {
              type: 'checkbox',
              checked: value === true,
              disabled: !snap.writable || busy,
              onChange: change(f.key),
            }),
            h('span', null, f.hint || ''),
          )
        } else if (f.kind === 'select') {
          control = h(
            'select',
            { style: S.input, value: String(value), disabled: !snap.writable || busy, onChange: change(f.key) },
            (f.options || []).map(([v, text]) => h('option', { key: v, value: v }, text)),
          )
        } else if (f.kind === 'voice-module') {
          control = renderVoiceModule(f, String(value ?? ''))
        } else if (f.kind === 'feiyu-voice') {
          control = renderFeiyuVoice(f, String(value ?? ''))
        } else if (f.kind === 'session') {
          control = h(
            'select',
            { style: S.input, value: String(value), disabled: !snap.writable || busy, onChange: change(f.key) },
            sessionOptions(sessionList, value, workspaceSnapshot?.archivedSessionIds).map((o) =>
              h('option', { key: o.value || '(none)', value: o.value }, o.label),
            ),
          )
        } else if (f.kind === 'group-list') {
          const groupRows = groupDisplayRows(value, groupMetas)
          const groupInput = h('input', {
            type: 'text',
            style: S.input,
            value: String(value),
            disabled: !snap.writable || busy,
            onChange: change(f.key),
            spellCheck: false,
          })
          const groupList =
            groupRows.length === 0
              ? null
              : h(
                  'div',
                  { style: S.groupList },
                  groupRows.map((row, index) =>
                    h(
                      'div',
                      { key: `${row.id}-${index}`, style: S.groupRow },
                      row.avatar
                        ? h('img', {
                            src: row.avatar,
                            alt: '',
                            width: 28,
                            height: 28,
                            referrerPolicy: 'no-referrer',
                            style: S.groupAvatar,
                            onError: (event) => {
                              const el = event && event.currentTarget
                              if (el && el.style) el.style.display = 'none'
                            },
                          })
                        : null,
                      h(
                        'div',
                        { style: S.groupText },
                        row.name ? h('div', { style: S.groupName }, row.name) : null,
                        h('div', { style: row.name ? S.groupId : S.groupIdOnly }, row.id),
                      ),
                    ),
                  ),
                )
          control = h('div', null, groupInput, groupList)
        } else if (f.kind === 'model-ref' || f.kind === 'vision-provider' || f.kind === 'vision-model') {
          // 这三类都是「从已配置的提供商/模型里选」，取不到清单时退化成手写输入框。
          const providers = catalog?.providers ?? []
          const hasCatalog = providers.length > 0
          if (f.kind === 'model-ref') {
            const allRefs = []
            for (const p of providers) for (const m of p.models) allRefs.push(`${p.id}/${m.id}`)
            const manual = h('input', {
              type: 'text',
              style: S.input,
              value: String(value ?? ''),
              placeholder: 'provider/model',
              disabled: !snap.writable || busy,
              onChange: change(f.key),
              spellCheck: false,
            })
            control = hasCatalog
              ? h(
                  'div',
                  null,
                  h(
                    'select',
                    {
                      style: S.input,
                      value: allRefs.includes(String(value ?? '')) ? String(value) : '',
                      disabled: !snap.writable || busy,
                      onChange: change(f.key),
                    },
                    [
                      h('option', { key: '(blank)', value: '' }, '（留空：用宿主默认 / 优先级链第一个）'),
                      ...providers.map((p) =>
                        h(
                          'optgroup',
                          { key: p.id, label: p.name || p.id },
                          p.models.map((m) => h('option', { key: `${p.id}/${m.id}`, value: `${p.id}/${m.id}` }, m.name || m.id)),
                        ),
                      ),
                      ...(String(value ?? '') !== '' && !allRefs.includes(String(value))
                        ? [h('option', { key: '__current', value: String(value) }, `${value}（当前值，不在清单里）`)]
                        : []),
                    ],
                  ),
                  catalogNote ? h('div', { style: S.hint }, catalogNote) : null,
                )
              : h(
                  'div',
                  null,
                  manual,
                  h('div', { style: S.hint }, catalogNote || '读不到模型清单，只能手写 provider/model。'),
                )
          } else {
            // vision-provider / vision-model：两段联动下拉。
            const providerId = String(shown.visionProvider ?? '')
            const picked = providers.find((p) => p.id === providerId)
            const modelList = picked?.models ?? []
            if (f.kind === 'vision-provider') {
              control = h(
                'select',
                {
                  style: S.input,
                  value: providers.some((p) => p.id === providerId) ? providerId : '',
                  disabled: !snap.writable || busy || f.kind !== 'vision-provider' || shown.visionMode !== 'fixed',
                  onChange: (event) => {
                    const next = { ...shown }
                    next.visionProvider = event.target.value
                    // 换提供商时清掉旧的模型：两个 provider 的 model id 不通用。
                    next.visionProviderModel = ''
                    setDraft(next)
                    setNote('')
                    setError('')
                  },
                },
                [
                  h('option', { key: '(none)', value: '' }, '（没选）'),
                  ...providers.map((p) => h('option', { key: p.id, value: p.id }, p.name || p.id)),
                  ...(providerId !== '' && !providers.some((p) => p.id === providerId)
                    ? [h('option', { key: '__current', value: providerId }, `${providerId}（当前值，不在清单里）`)]
                    : []),
                ],
              )
            } else {
              const modelId = String(shown.visionProviderModel ?? '')
              control = h(
                'select',
                {
                  style: S.input,
                  value: modelList.some((m) => m.id === modelId) ? modelId : '',
                  disabled: !snap.writable || busy || shown.visionMode !== 'fixed' || providerId === '',
                  onChange: change(f.key),
                },
                [
                  h('option', { key: '(none)', value: '' }, providerId === '' ? '（先选提供商）' : '（没选）'),
                  ...modelList.map((m) =>
                    h('option', { key: m.id, value: m.id }, `${m.name || m.id}${m.vision ? ' · 支持识图' : ''}`),
                  ),
                  ...(modelId !== '' && !modelList.some((m) => m.id === modelId)
                    ? [h('option', { key: '__current', value: modelId }, `${modelId}（当前值，不在清单里）`)]
                    : []),
                ],
              )
            }
            control = h(
              'div',
              null,
              control,
              shown.visionMode !== 'fixed'
                ? h('div', { style: S.hint }, '「识图用哪个模型」选了「指定一个模型」才生效。')
                : catalogNote
                  ? h('div', { style: S.hint }, catalogNote)
                  : null,
            )
          }
        } else if (f.kind === 'preset') {
          const presets = catalog?.presets ?? []
          const cur = String(value ?? '')
          control = h(
            'select',
            {
              style: S.input,
              value: presets.some((p) => p.id === cur) ? cur : '',
              disabled: !snap.writable || busy,
              onChange: change(f.key),
            },
            [
              h('option', { key: '(none)', value: '' }, '（不挂载预设）'),
              ...presets.map((p) => h('option', { key: p.id, value: p.id }, p.name || p.id)),
              ...(cur !== '' && !presets.some((p) => p.id === cur)
                ? [h('option', { key: '__current', value: cur }, `${cur}（当前值，不在清单里）`)]
                : []),
            ],
          )
        } else if (f.kind === 'model-chain') {
          control = renderModelChain(f, Array.isArray(value) ? value : [])
        } else if (f.kind === 'profiles') {
          control = renderProfiles(f, Array.isArray(value) ? value : [])
        } else if (f.kind === 'secret') {
          // 口令类：永远不把存着的值回显出来，框里是空的；留空 = 不改。
          control = h('input', {
            type: 'password',
            style: S.input,
            value: String(value ?? ''),
            placeholder: overridden ? '（已设置，留空不改）' : '（没设）',
            autoComplete: 'off',
            disabled: !snap.writable || busy,
            onChange: change(f.key),
            spellCheck: false,
          })
        } else {
          control = h('input', {
            type: f.kind === 'number' ? 'number' : 'text',
            ...(f.step ? { step: f.step } : {}),
            style: S.input,
            value: String(value),
            disabled: !snap.writable || busy,
            onChange: change(f.key),
            spellCheck: false,
          })
        }
        rows.push(
          h(
            'div',
            { key: f.key, style: S.label },
            f.label,
            overridden ? h('span', { style: S.overridden }, '·已覆盖') : null,
            // 每个字段都有自己的标签格，所以逐字段放按钮对所有类型都成立 —— 不必只给一个统一按钮。
            overridden
              ? h(
                  'button',
                  {
                    type: 'button',
                    style: disabled(S.link, busy || !snap.writable),
                    disabled: busy || !snap.writable,
                    title: '清掉设置文件里的这一项，回落到 composition config 的值',
                    onClick: () => unsetOverride(f.key),
                  },
                  '撤销覆盖',
                )
              : null,
          ),
        )
        rows.push(
          h(
            'div',
            { key: `${f.key}-ctl` },
            control,
            f.kind !== 'boolean' && f.hint
              ? h(
                  'div',
                  { style: S.hint },
                  // 会话下拉额外把真实 id 显示出来：看着名字选，但真要手抄/核对时 id 就在旁边
                  (f.kind === 'session' && String(value) !== '' ? `${f.hint}当前：${value}` : f.hint) +
                    (typeof f.check === 'function' && f.check(value) ? `\n⚠️ ${f.check(value)}` : ''),
                )
              : null,
          ),
        )
      }

      // 地址由宿主拼好：填了「NapCat 网页管理地址」就用它，否则用 webui.json。
      // 回环地址按钮保持可点（本机用户需要），旁边说明只有跑着 NapCat 的机器打得开。
      const webuiUrl = napcat && typeof napcat.webuiUrl === 'string' ? napcat.webuiUrl : ''
      const webuiHint = napcat && typeof napcat.webuiHint === 'string' ? napcat.webuiHint : ''
      const dirHint = napcat && typeof napcat.installDirMissingHint === 'string' ? napcat.installDirMissingHint : ''
      // 宿主报的 running 是权威判据（含外部启动的 NapCat）。拿不到状态时按未运行处理。
      const napcatRunning = napcat !== null && napcat.running === true
      const napcatOps = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h(
          'div',
          { style: S.ops },
          h(
            'button',
            {
              type: 'button',
              style: disabled(S.btn, webuiUrl === '' || napcatBusy !== ''),
              disabled: webuiUrl === '' || napcatBusy !== '',
              onClick: () => {
                if (webuiUrl !== '') window.open(webuiUrl, '_blank', 'noopener')
              },
            },
            '打开 WebUI',
          ),
          h(
            'button',
            {
              type: 'button',
              style: disabled(S.btn, napcatRunning || napcatBusy !== ''),
              disabled: napcatRunning || napcatBusy !== '',
              onClick: () => postNapcat('launch', '已启动 NapCat'),
            },
            napcatRunning ? '已在运行' : napcatBusy === 'launch' ? '启动中…' : '启动 NapCat',
          ),
          h(
            'button',
            {
              type: 'button',
              style: disabled(S.btn, napcatBusy !== ''),
              disabled: napcatBusy !== '',
              onClick: () =>
                postNapcat('reveal', napcat && napcat.installDir ? `已打开文件夹：${napcat.installDir}` : '已打开文件夹'),
            },
            napcatBusy === 'reveal' ? '打开中…' : '打开文件夹',
          ),
        ),
        webuiUrl === ''
          ? h('div', { style: S.hint }, '没读到 webui.json。远程或自己部署时，请填写上面的「NapCat 网页管理地址」。')
          : null,
        webuiUrl !== '' && webuiHint !== '' ? h('div', { style: S.hint }, webuiHint) : null,
        dirHint !== '' ? h('div', { style: S.hint }, dirHint) : null,
      )

      const header = h(
        'button',
        { type: 'button', onClick: () => setOpen(!open), 'aria-expanded': open, style: S.header },
        h('span', { style: S.title }, 'QQ 桥接 Neko'),
        h('span', { style: S.sub }, dirty ? '有未保存的改动' : pluginVersion ? `当前版本 ${pluginVersion}` : '把固定的 DSH 会话接到 QQ'),
        h('span', { style: S.chevron }, open ? '▴' : '▾'),
      )
      const versionLine = pluginVersion
        ? `当前版本 ${pluginVersion}`
        : versionState === 'loading'
          ? '正在读取当前版本…'
          : '当前版本暂时读不到。确认 dsh-web 已重启后再打开这张卡片。'
      const updateBox = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('div', { style: S.sub }, versionLine),
        h(
          'div',
          { style: S.ops },
          h(
            'button',
            {
              type: 'button',
              style: disabled(S.btn, updateBusy),
              disabled: updateBusy,
              onClick: () => {
                checkForUpdate()
              },
            },
            updateBusy && updateKind === 'check' ? '检查中…' : '检查更新',
          ),
          updateOffer
            ? h(
                'button',
                {
                  type: 'button',
                  style: disabled({ ...S.btn, ...S.primary }, updateBusy),
                  disabled: updateBusy,
                  onClick: () => {
                    applyUpdate()
                  },
                },
                updateBusy && updateKind === 'apply' ? '正在更新…' : `更新到 ${updateOffer.tag}`,
              )
            : null,
        ),
        h('div', { style: S.hint }, '只检查，不安装。'),
        updateOffer
          ? h('div', { style: S.hint }, '装完会重启面板。请刷新；登录口令可能会变。不改 NapCat。')
          : null,
        updateNote
          ? h('div', { style: { ...(updateIsError ? S.err : S.note), whiteSpace: 'pre-wrap' } }, updateNote)
          : null,
      )

      // 分类页签：60 多个字段铺成一条太长了，一次只看一页。
      // 每页只列属于它的字段；当前页高亮。
      const tabsRow = h(
        'div',
        { style: S.tabs },
        GROUPS.map((g) =>
          h(
            'button',
            {
              key: g.id,
              type: 'button',
              style: { ...S.tab, ...(g.id === activeGroup ? S.tabActive : {}) },
              onClick: () => setActiveGroup(g.id),
            },
            g.label,
          ),
        ),
      )

      if (!open) return h('div', { style: S.wrap }, header)
      return h(
        'div',
        { style: S.wrap },
        header,
        updateBox,
        tabsRow,
        h('div', { style: S.grid }, rows),
        activeGroup === 'napcat' || activeGroup === 'connect' ? napcatOps : null,
        h(
          'div',
          { style: S.foot },
          h(
            'button',
            {
              type: 'button',
              style: disabled({ ...S.btn, ...S.primary }, !dirty || busy || !snap.writable),
              disabled: !dirty || busy || !snap.writable,
              onClick: save,
            },
            busy ? '保存中…' : '保存',
          ),
          h(
            'button',
            {
              type: 'button',
              style: disabled(S.btn, !dirty || busy),
              disabled: !dirty || busy,
              onClick: () => {
                setDraft(null)
                setError('')
                setNote('')
              },
            },
            '放弃修改',
          ),
          !snap.writable ? h('span', { style: S.note }, '（只读：这个连接不改宿主文档）') : null,
          error ? h('span', { style: S.err }, error) : null,
          !error && note ? h('span', { style: S.note }, note) : null,
        ),
      )
    }

    // ── 插件 ──────────────────────────────────────────────────────────────────

    /** 需要的浏览器服务：slots（注册卡片）；settingsScope 在 apply 里等它出现。 */
    const inject = ['slots']

    // TODO(0.2.0): 平台把第三方插件的设置桥接上之后（web-all / DSH 修完 #677 的迁移），
    // 可以砍掉多余候选 key 与卡片上那行“诊断”；`namespaces` / `detail()` 建议保留（排障用）。
    // 详见 docs/dsh-0.2.0-migration.md 的 TODO 节。
    /**
     * 绑一个**可写的**设置域。导出（经 __test）以便离线测试。
     *
     * 两代 DSH 对“这个插件的设置”用的 key 不一样：
     *   0.1.5-rc.3：settings 命名空间 —— `qq-bridge-neko`（宿主半 register 出来的）；
     *   0.2.0     ：profile **entry id** —— `include:qq-bridge-neko`（由插件自己的 Config 投影而来）。
     * 只绑前者的话，0.2.0 上永远拿到 `unavailable`，用户看到的就是“这个部署没有为 qq-bridge-neko
     * 提供可写的设置服务”（2026-10-01 桌面端真机）。所以**两个都绑，谁 ready 用谁**。
     */
    /** 0.2.0 的兜底数据源：宿主自己挂的本机接口（见宿主半的 handleSettingsRequest）。 */
    const API_PATH = '/api/qq-bridge-neko/settings'
    /** NapCat 操作接口（宿主半不受 legacy 门控，两代宿主都挂）。 */
    const NAPCAT_API = '/api/qq-bridge-neko/napcat'
    /** 检查更新。GET 只读当前版本；POST 不带 action 只检查。安装要另发 action 为 apply。浏览器不直接访问 npm 或 GitHub。 */
    const UPDATE_API = '/api/qq-bridge-neko/update'
    /** 群白名单的群名和头像。只读；保存仍走设置接口。 */
    const GROUP_META_API = '/api/qq-bridge-neko/groups'
    /** 可选项清单：已配置的提供商 / 模型 / 人设预设。只读，用来做下拉。 */
    const CATALOG_API = '/api/qq-bridge-neko/catalog'
    /** 已知的 QQ 目的地（群 / 私聊），给「单独设置」那栏用。只读。 */
    const PROFILES_API = '/api/qq-bridge-neko/profiles'
    /** 稳定引用：useSyncExternalStore 的 getSnapshot 每次返回新对象会死循环。 */
    const LOADING_SNAPSHOT = { status: 'loading' }
    const UNAVAILABLE_SNAPSHOT = { status: 'unavailable' }

    /**
     * 走宿主本机接口的设置域（0.2.0 用）。
     *
     * 为什么需要它：0.2.0 的 `webUiSettings` 桥对第三方插件永远返回 `unavailable`
     * （证据见 docs/dsh-0.2.0-migration.md）。范本：皮肤中心
     * `@linxin666/dsh-client-ui-skin-center` 就是自己 `inject: ["webServer"]` 挂
     * `/api/skin-center/...`，浏览器半直接 fetch 它，全程不碰宿主 settings 服务。
     *
     * 小 store：fetch 一次 → 缓存 snapshot → 通知订阅者；`set` 走 POST 再刷新。
     * 快照形状与宿主 scope 对齐（`status` / `value` / `user` / `writable`），卡片不用改。
     */
    function createApiScope() {
      const listeners = new Set()
      let snapshot = { status: 'idle' }
      let started = false
      const publish = (next) => {
        snapshot = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            // 一个订阅者抛错不该影响别人
          }
        }
      }
      const accept = (body) => {
        const overridden = Array.isArray(body?.overridden) ? body.overridden : []
        publish({
          status: 'ready',
          value: body?.values && typeof body.values === 'object' ? body.values : {},
          user: Object.fromEntries(overridden.map((key) => [key, true])),
          writable: true,
        })
      }
      const load = async () => {
        if (typeof fetch !== 'function') {
          publish({ status: 'unavailable', reason: 'no-fetch' })
          return
        }
        publish({ status: 'loading' })
        try {
          const res = await fetch(API_PATH, { credentials: 'include', headers: { accept: 'application/json' } })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`)
          accept(body)
        } catch (error) {
          publish({ status: 'unavailable', reason: `api: ${error?.message ?? error}` })
        }
      }
      return {
        kind: 'api',
        getSnapshot: () => snapshot,
        start: () => {
          if (started) return
          started = true
          load()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set: async (field, value) => {
          const res = await fetch(API_PATH, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ set: { [field]: value } }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`)
          accept(body)
        },
        /** 撤销一个字段的本机覆盖：接口本来就支持 `unset`，这里只是把它暴露给卡片。 */
        unset: async (field) => {
          if (typeof fetch !== 'function') throw new Error('qq-bridge-neko: 这个环境没有 fetch')
          const res = await fetch(API_PATH, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ unset: [field] }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`)
          accept(body)
        },
      }
    }

    /**
     * 绑一个**可写的**设置域。导出（经 __test）以便离线测试。
     *
     * 两代 DSH 对“这个插件的设置”用的 key 不一样：
     *   0.1.5-rc.3：settings 命名空间 —— `qq-bridge-neko`（宿主半 register 出来的）；
     *   0.2.0     ：profile **entry id** —— `include:qq-bridge-neko`（由插件自己的 Config 投影而来）。
     * 只绑前者的话，0.2.0 上永远拿到 `unavailable`，用户看到的就是“这个部署没有为 qq-bridge-neko
     * 提供可写的设置服务”（2026-10-01 桌面端真机）。所以**两个都绑、谁 ready 用谁**；
     * **全都不 ready** 时再退到宿主自己的本机接口（0.2.0 的兜底，见 createApiScope）。
     */
    function bindSettings(service) {
      const unavailable = UNAVAILABLE_SNAPSHOT
      const candidates = []
      // 0.2.0 的表单 key 到底叫什么，源码里能看到的写法**全试一遍**（谁 ready 用谁）：
      // settings 命名空间 / profile entry id / 包名，以及带 include: 前缀的两种。
      for (const namespace of [NS, `include:${NS}`, '@fengye_nobug/dsh-qq-bridge-neko', 'include:@fengye_nobug/dsh-qq-bridge-neko', 'dsh-qq-bridge-neko', 'include:dsh-qq-bridge-neko', 'dsh-qq-bridge', 'include:dsh-qq-bridge']) {
        try {
          const scope = service.bind({ namespace })
          if (scope && typeof scope === 'object') candidates.push({ namespace, scope })
        } catch (error) {
          // 某个候选绑不上不影响另一个。
          console?.debug?.(`qq-bridge-neko: bind(${namespace}) 失败：${error?.message ?? error}`)
        }
      }
      const snapshotOf = (candidate) => {
        try {
          return candidate.scope.getSnapshot?.() ?? unavailable
        } catch {
          return unavailable
        }
      }
      const readyScope = () => candidates.find((candidate) => snapshotOf(candidate).status === 'ready')
      const anyLoading = () => candidates.some((candidate) => snapshotOf(candidate).status === 'loading')
      const api = createApiScope()
      return {
        // 供排障/测试看：这次到底绑到了哪些 key
        namespaces: candidates.map((candidate) => candidate.namespace),
        /** 这次数据从哪来（排障/测试用）：'scope' | 'api' | 'none'。 */
        via: () => {
          if (readyScope()) return 'scope'
          return api.getSnapshot().status === 'ready' ? 'api' : 'none'
        },
        /**
         * 每个候选的当前状态。直接显示在卡片上 —— 0.2.0 的 key 叫什么，
         * 与其猜，不如让它自己报（2026-10-01 真机就是靠这个收敛的）。
         */
        detail: () => {
          const scopes =
            candidates.length === 0
              ? '一个候选都没绑上（webUiSettings.bind 全部抛错）'
              : candidates.map((candidate) => `${candidate.namespace}=${snapshotOf(candidate).status}`).join('、')
          const apiSnap = api.getSnapshot()
          return `${scopes}；本机接口=${apiSnap.status}${apiSnap.reason ? `（${apiSnap.reason}）` : ''}`
        },
        getSnapshot: () => {
          const candidate = readyScope()
          if (candidate) return snapshotOf(candidate)
          // scope 全不可用 → 退到宿主本机接口；第一次问就把它跑起来。
          if (!anyLoading()) api.start()
          const apiSnap = api.getSnapshot()
          if (apiSnap.status === 'ready') return apiSnap
          if (apiSnap.status === 'loading' || apiSnap.status === 'idle') return LOADING_SNAPSHOT
          return unavailable
        },
        subscribe: (listener) => {
          const offs = []
          for (const candidate of candidates) {
            try {
              const off = candidate.scope.subscribe?.(listener)
              if (typeof off === 'function') offs.push(off)
            } catch {
              // 订阅失败不影响其它候选
            }
          }
          offs.push(api.subscribe(listener))
          if (!readyScope() && !anyLoading()) api.start()
          return () => {
            for (const off of offs) off()
          }
        },
        set: (field, value) => {
          const candidate = readyScope()
          if (candidate && typeof candidate.scope.set === 'function') return candidate.scope.set(field, value)
          if (api.getSnapshot().status === 'ready') return api.set(field, value)
          throw new Error('qq-bridge-neko: 没有可写的设置源')
        },
        /**
         * 撤销一个字段的本机覆盖。
         *
         * 优先用设置域自己的 `unset`（DSH 的 SettingsScope 有这个能力）；
         * 设置域没有它时走本机接口的 `unset`（宿主半的 handleSettingsRequest 本来就支持）。
         */
        unset: (field) => {
          const candidate = readyScope()
          if (candidate && typeof candidate.scope.unset === 'function') return candidate.scope.unset(field)
          return api.unset(field)
        },
      }
    }

    /** 插件详情页只在这一包上显示设置。旧包名和 Cordis id 也认。 */
    function subjectIsOurs(subject) {
      if (!subject || typeof subject !== 'object') return false
      const pkgName = subject.pkg && typeof subject.pkg === 'object' ? String(subject.pkg.name ?? '') : ''
      if (pkgName === '@fengye_nobug/dsh-qq-bridge-neko' || pkgName === 'dsh-qq-bridge-neko' || pkgName === 'dsh-qq-bridge') return true
      const id = String(subject.id ?? '')
      if (id === NS || id === '@fengye_nobug/dsh-qq-bridge-neko' || id === 'dsh-qq-bridge-neko' || id === 'dsh-qq-bridge') return true
      if (subject.kind === 'item' && id.includes('qq-bridge-neko')) return true
      const pkg = String(subject.package ?? subject.packageName ?? '')
      return pkg === '@fengye_nobug/dsh-qq-bridge-neko' || pkg === 'dsh-qq-bridge-neko' || pkg === 'dsh-qq-bridge'
    }

    /**
     * 不经过宿主设置服务，直接读写 `/api/qq-bridge-neko/settings`。
     * DSH 0.2.x 上 `settingsScope` / `webUiSettings` 可能根本不存在；再等它们，卡片永远不会挂上。
     */
    function apiBoundScope() {
      const api = createApiScope()
      return {
        namespaces: [],
        via: () => (api.getSnapshot().status === 'ready' ? 'api' : 'none'),
        detail: () => {
          const apiSnap = api.getSnapshot()
          return `本机接口=${apiSnap.status}${apiSnap.reason ? `（${apiSnap.reason}）` : ''}`
        },
        getSnapshot: () => {
          api.start()
          const apiSnap = api.getSnapshot()
          if (apiSnap.status === 'ready') return apiSnap
          if (apiSnap.status === 'loading' || apiSnap.status === 'idle') return LOADING_SNAPSHOT
          return UNAVAILABLE_SNAPSHOT
        },
        subscribe: (listener) => {
          const off = api.subscribe(listener)
          api.start()
          return off
        },
        set: (field, value) => api.set(field, value),
        unset: (field) => api.unset(field),
      }
    }

    /**
     * 左下角入口：侧栏脚部、Settings 上面那个小按钮。
     *
     * 为什么不用 `sidebar.settings` 自己顶上：那个座位是 single，已经被宿主设置页占了，
     * 抢不到。`sidebar.footer.action` 是 list，可以并存 —— 于是入口挂在这里，
     * 点开后是一个居中的浮层面板，里面就是设置本体（分类页签 + 当前页字段）。
     */
    function FootEntry(props) {
      const [open, setOpen] = react.useState(false)
      const wide = props?.wide !== false
      // Esc 关掉：浮层铺满窗口，没有键盘退出会让人以为被卡住了。
      react.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event?.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const entry = h(
        'button',
        {
          type: 'button',
          style: S.footEntry,
          title: 'QQ 桥接 Neko 设置',
          onClick: () => setOpen(true),
        },
        h('span', { style: S.footEntryIcon }, '🐟'),
        wide ? h('span', null, 'QQ 桥接 Neko') : null,
      )
      if (!open) return entry

      return h(
        react.Fragment,
        null,
        entry,
        h(
          'div',
          {
            style: S.overlay,
            onClick: (event) => {
              // 点遮罩关掉，点面板本身不关。
              if (event.target === event.currentTarget) setOpen(false)
            },
          },
          h(
            'div',
            { style: S.sheet },
            h(
              'div',
              { style: S.sheetHead },
              h('div', { style: S.sheetTitle }, 'QQ 桥接 Neko'),
              h('button', { type: 'button', style: S.link, onClick: () => setOpen(false) }, '关闭'),
            ),
            typeof props?.render === 'function' ? props.render() : null,
          ),
        ),
      )
    }

    function apply(ctx) {
      // 卡片立刻挂上，不等 settingsScope / webUiSettings。
      // 这两个服务在部分 0.2.x 上不存在，ctx.inject 会一直等，回调永远不跑。
      // 设置数据：宿主设置域已经在就用它（0.1.5 的命名空间、以及还能 bind 的 webUiSettings）；
      // 否则用本插件自己的设置接口。请求带 credentials: 'include'，好把面板登录 cookie 带上。
      let registered = false
      let hostBound = false
      const listeners = new Set()
      let inner = null
      let innerOff = () => {}
      const notify = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            // 一个订阅者抛错不影响别人
          }
        }
      }
      const adopt = (next) => {
        try {
          innerOff()
        } catch {
          // 旧订阅卸不掉就盖掉
        }
        inner = next
        const off = inner.subscribe?.(notify)
        innerOff = typeof off === 'function' ? off : () => {}
        notify()
      }
      const scope = {
        via: () => (typeof inner?.via === 'function' ? inner.via() : 'none'),
        detail: () => (typeof inner?.detail === 'function' ? inner.detail() : ''),
        getSnapshot: () => inner.getSnapshot(),
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set: (field, value) => inner.set(field, value),
        unset: (field) => inner.unset(field),
      }
      const mount = (scoped) => {
        if (registered) return
        if (!scoped?.slots || typeof scoped.slots.inject !== 'function') return
        registered = true
        const card = () =>
          h(Card, { scope, sessionsOf: () => ctx.get('sessions'), workspacesOf: () => ctx.get('workspaces') })
        // slots.inject 只在那个 slot 存在时才跑回调，多注册一个是安全的。
        const registerCard = (slot, options, render) => {
          try {
            scoped.slots.inject(slot, () => scoped.slots.register({ ...options, name: slot }, render || card))
          } catch (error) {
            console?.debug?.(`qq-bridge-neko: slot ${slot} unavailable (${error?.message ?? error})`)
          }
        }
        registerCard('settings.plugins.tab', { id: NS, order: 100, label: () => 'QQ 桥接 Neko' })
        registerCard('settings.plugin.item', { key: NS })
        registerCard('plugins.tab', { id: NS, order: 100, label: () => 'QQ 桥接 Neko' })
        // 左下角入口：侧栏脚部（Settings 上方）。list 型座位，可以和别人并存。
        // 点开是个浮层面板，里面就是这套设置 —— 不用再钻进「插件」里翻。
        registerCard('sidebar.footer.action', { id: NS, order: 100 }, (props) =>
          h(FootEntry, { wide: props?.wide, render: card }),
        )
        registerCard(
          'plugins.detail.section',
          { id: 'qq-bridge-neko-settings', order: 50, label: () => 'QQ 桥接 Neko 设置' },
          (props) => {
            const subject = props && props.subject
            if (subject && !subjectIsOurs(subject)) return null
            return card()
          },
        )
      }
      const preferHost = (service) => {
        if (hostBound) return
        if (!service || typeof service.bind !== 'function') return
        hostBound = true
        adopt(bindSettings(service))
      }
      const tryInject = (name, pick) => {
        if (typeof ctx.inject !== 'function') return
        try {
          ctx.inject([name], (scoped) => preferHost(pick(scoped)))
        } catch {
          // 没有这扇门：下面会改走设置接口。
        }
      }
      tryInject('webUiSettings', (scoped) => scoped.webUiSettings ?? scoped.get?.('settingsScope'))
      tryInject('settingsScope', (scoped) => scoped.settingsScope ?? scoped.get?.('webUiSettings'))
      if (!hostBound) adopt(apiBoundScope())
      mount(ctx)
    }

    exports.apply = apply
    exports.inject = inject
    // 导出 name：Cordis 用它做插件标识，Slots inspect 里的 registrant 会显示成它
    // （不导的话那边显示的是产物里的 fallback 短名，排障时认不出是谁注册的卡片）。
    exports.name = '@fengye_nobug/dsh-qq-bridge-neko'
    // 纯函数给离线测试用（test-smoke.mjs 会在假 ctx 里真跑这个 bundle）。
    // Cordis 只认 apply / inject / name / Config，多余的导出它不管。
    exports.__test = { sessionOptions, draftFrom, parse, fields: FIELDS, bindSettings, groupDisplayRows, groups: GROUPS, usesFeiyu, localOnlyKeys: [...LOCAL_ONLY_KEYS], feiyuOnlyKeys: [...FEIYU_ONLY_KEYS] }
    return module.exports
  },
})
