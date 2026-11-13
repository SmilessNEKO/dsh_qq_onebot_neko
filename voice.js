// voice.js — 出站语音：把「[语音]台词[/语音]」拆出来、合成音频、组 OneBot record 段。
//
// 分工：
//   * `splitVoiceBlocks()` 纯函数，负责把一段正文切成有序的 text / voice 片段；
//   * `synthesize()` 是统一入口，按 `provider` 三路分派：
//       - `edge`  ：本机 edge-tts（子进程，吐 mp3，**默认**）
//       - `sherpa`：本机 sherpa-onnx 离线 VITS 模型（子进程 + lameenc，吐 mp3，不联网）
//       - `feiyu` ：肥鱼声音服务（本机 HTTP，提交任务 → 轮询 → 下 WAV）
//   * `ensureRecordAudio()` 把产物变成 NapCat 稳吃的 mp3（只有 wav 才转，没 ffmpeg 就原样发）；
//   * `recordSegment()` 把音频路径变成 OneBot 的 record 段。
//
// 默认 provider 永远是 edge：认不出时回落 edge，老用户升级后行为不变。
// 为什么不自己转 silk：NapCat 收到 mp3 会自己转码（实测 mp3 直传 retcode 0）。
// 换成别的 OneBot 实现、对方不吃 mp3 时，再在这里补 silk-wasm 转码。

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 语音标记的正则：`[语音]…[/语音]`，允许跨行。 */
const VOICE_BLOCK_RE = /\[语音\]([\s\S]*?)\[\/语音\]/g

/** 默认音色：偏奶甜的少女音，与仓库里预录素材是同一档。 */
export const DEFAULT_TTS_VOICE = 'zh-CN-XiaoyiNeural'
/** 默认语速 / 音高，跟预录素材的调参一致。 */
export const DEFAULT_TTS_RATE = '-8%'
export const DEFAULT_TTS_PITCH = '+12Hz'
/** 单条语音的字数上限。太长合成慢、听起来也累。 */
export const DEFAULT_VOICE_MAX_CHARS = 120
/**
 * 一首歌的歌词上限（字）。
 *
 * 一个音符一个字，所以这就是「最多唱多少个音符」；15 秒 demo 约 10 个字，
 * 一分钟的歌一百多字。给到 400 够唱两三分钟，再长就分段做。
 */
export const DEFAULT_VOICE_MAX_SONG_CHARS = 400
/** 合成超时。edge-tts 正常 1–2 秒出一句，给足余量但别无限等。 */
export const DEFAULT_TTS_TIMEOUT_MS = 20000

// ── 肥鱼声音服务（本机 HTTP 服务，端口 9880）──────────────────────────────────
//
// 协议（对端由用户自己部署，与 edge-tts / sherpa 并存）：
//   POST /v1/speech                → 202 + 任务号
//   GET  /v1/jobs/{id}             → queued / running / success / failed / interrupted
//   GET  /v1/jobs/{id}/audio       → 成功后的 WAV
// 三个接口都要同一个 `Authorization: Bearer <key>`（没配 key 就不带这个头）。

/** 默认 provider：永远是 edge —— 没显式选肥鱼 / sherpa 就绝不换实现。 */
export const DEFAULT_VOICE_PROVIDER = 'edge'
/** 认得出的 provider 名。 */
export const VOICE_PROVIDERS = ['edge', 'sherpa', 'feiyu']
/** 肥鱼声音服务的默认地址（本机、不对外）。 */
export const DEFAULT_FEIYU_BASE_URL = 'http://127.0.0.1:9880'
/** 默认音色名 / 语气。 */
export const DEFAULT_FEIYU_VOICE = 'feiyu'
export const DEFAULT_FEIYU_STYLE = 'cute'
/** 认得出的语气。 */
export const FEIYU_STYLES = ['cute', 'gentle']
/**
 * 肥鱼的整体超时（毫秒）。
 *
 * 比 edge 的 20 秒大一个量级：首次请求要加载模型，几十秒到几分钟都正常。
 */
export const DEFAULT_FEIYU_TIMEOUT_MS = 180000
/** 轮询任务状态的间隔（毫秒）。 */
export const DEFAULT_FEIYU_POLL_INTERVAL_MS = 1000
/** ffmpeg 转码的超时（毫秒）。 */
export const DEFAULT_FFMPEG_TIMEOUT_MS = 30000
/**
 * 唱歌的整体超时（毫秒）。
 *
 * 唱歌要比说话慢一个量级：谱面编译 → SVS 逐段推理 → RVC 换声 → 混音，
 * 15 秒的歌实测 60–90 秒；给足 10 分钟，别让长一点的曲子半路被掐。
 */
export const DEFAULT_FEIYU_SING_TIMEOUT_MS = 600000
/**
 * 肥鱼服务空闲多久就自己停掉（分钟）。0 = 不停。
 *
 * 服务是常驻 GPU 进程：没人用的时候占着显存不放，别人的机器上尤其难受。
 * 插件每次合成完重置计时器，到点把**自己拉起来的**那个进程停掉。
 */
export const DEFAULT_FEIYU_IDLE_STOP_MINUTES = 10
/**
 * 拉服务起来之后，等它 `/health` 通的最长时间（毫秒）。
 *
 * 首次启动要 import torch、扫模型目录，实测 10–30 秒；给 60 秒余量。
 */
export const DEFAULT_FEIYU_START_TIMEOUT_MS = 60000
/** 探测 `/health` 的单次超时（毫秒）。服务没起时本机会立刻 ECONNREFUSED，不用等太久。 */
export const DEFAULT_FEIYU_PROBE_TIMEOUT_MS = 3000

// ── 肥鱼服务的自动启停 ───────────────────────────────────────────────────────
//
// 为什么要插件自己管：服务是个常驻 GPU 进程，没人用也占着显存；而「没起服务就
// 发不出语音」又会让人以为插件坏了。所以两条一起做：
//   1. 合成前先探 `GET /health`（免鉴权），不通就按配置把服务拉起来，等它通；
//   2. 每次合成成功刷新「最后使用时间」，空闲到点就停 —— 优先走服务端的
//      `POST /v1/admin/shutdown`（它自己会校验队列空才退，任务不会丢），
//      退回才 kill 我们自己 spawn 的那个进程。
//
// 只停自己拉起来的？不。**只要能探通就纳入计时**：手工起的服务同样是占显存的
// 那个进程，主人抱怨的正是「起了一直不停」。想让它常驻就把
// `feiyuIdleStopMinutes` 设成 0 —— 这是唯一的开关，不额外加隐藏行为。
//
// 每个 baseUrl 一份状态，互不影响（同时配两个地址也不会串）。

/** baseUrl → 状态。 */
const feiyuServices = new Map()

/** 状态键：去掉末尾斜杠，`http://a/` 与 `http://a` 算同一个。 */
function serviceKey(baseUrl) {
  return String(baseUrl ?? '').trim().replace(/\/+$/, '') || DEFAULT_FEIYU_BASE_URL
}

/** 清掉某个地址的计时器（不杀进程）。 */
function clearIdleTimer(entry) {
  if (entry?.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
}

/**
 * 探测服务是否活着。
 *
 * 用 `/health`（免鉴权、极轻），而不是 `/v1/capabilities`：后者要带口令，
 * 口令错的时候会跟「服务没起」混成一个原因，排障时分不清。
 *
 * @param {{ baseUrl?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ ok: boolean, reason?: string, version?: string }>}
 */
export async function probeFeiyuService(options) {
  const {
    baseUrl = DEFAULT_FEIYU_BASE_URL,
    timeoutMs = DEFAULT_FEIYU_PROBE_TIMEOUT_MS,
    fetchImpl,
  } = options ?? {}
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return { ok: false, reason: 'no-fetch' }

  let root
  try {
    root = new URL(serviceKey(baseUrl))
  } catch {
    return { ok: false, reason: 'bad-base-url' }
  }
  if (root.protocol !== 'http:' && root.protocol !== 'https:') {
    return { ok: false, reason: `bad-base-url: ${root.protocol}` }
  }
  const href = root.href.endsWith('/') ? root.href : `${root.href}/`
  const target = new URL('health', href).toString()

  try {
    const response = await doFetch(target, {
      method: 'GET',
      signal: AbortSignal.timeout(Math.max(1, Number(timeoutMs) || DEFAULT_FEIYU_PROBE_TIMEOUT_MS)),
    })
    if (!response.ok) return { ok: false, reason: `health-http-${response.status}` }
    const payload = await readJsonSafe(response)
    return { ok: true, version: String(payload?.version ?? '').trim() }
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return { ok: false, reason: 'health-timeout' }
    }
    const code = error?.cause?.code ?? error?.code ?? ''
    return { ok: false, reason: `service-down: ${code || String(error?.message ?? error)}` }
  }
}

/** 记一次「刚用过」，把空闲计时器往后推。 */
export function noteFeiyuActivity(options) {
  const entry = feiyuServices.get(serviceKey(options?.baseUrl))
  if (!entry) return
  entry.lastUsedAt = Date.now()
  scheduleIdleStop(entry, options?.idleStopMs ?? entry.idleStopMs)
}

/** 排一次空闲自停。`idleStopMs <= 0` 表示不停。 */
function scheduleIdleStop(entry, idleStopMs) {
  clearIdleTimer(entry)
  const budget = Number(idleStopMs)
  if (!Number.isFinite(budget) || budget <= 0) return
  entry.idleStopMs = budget
  const timer = setTimeout(() => {
    entry.timer = null
    // 到点时如果刚好又在合成（lastUsedAt 被刷新过），就再等一轮，别掐任务。
    const since = Date.now() - (entry.lastUsedAt ?? 0)
    if (since < budget) {
      scheduleIdleStop(entry, budget - since)
      return
    }
    stopFeiyuService(entry.baseUrl, { reason: 'idle', fetchImpl: entry.fetchImpl }).catch(() => {})
  }, budget)
  // 别为了一个计时器把宿主进程吊着不退出（测试里尤其明显）。
  if (typeof timer.unref === 'function') timer.unref()
  entry.timer = timer
}

/**
 * 停掉服务。
 *
 * 先礼后兵：`POST /v1/admin/shutdown` 让服务自己走 lifespan 收尾（释放显存、
 * 放掉队列锁）；它拒绝（有任务在跑 / 版本不支持 / 口令不对）或不通，再退回到
 * kill 我们自己 spawn 的那个进程。**不是我们拉起来的进程绝不动手** ——
 * 别人的服务不该被我们凭空杀掉。
 *
 * @param {string} baseUrl
 * @param {{ reason?: string, apiKey?: string, fetchImpl?: typeof fetch, graceMs?: number }} [options]
 */
export async function stopFeiyuService(baseUrl, options) {
  const key = serviceKey(baseUrl)
  const entry = feiyuServices.get(key)
  if (!entry) return { stopped: false, reason: 'unknown-service' }
  clearIdleTimer(entry)
  feiyuServices.delete(key)

  const { apiKey = entry.apiKey, fetchImpl = entry.fetchImpl, graceMs = 8000 } = options ?? {}
  const doFetch = fetchImpl ?? globalThis.fetch
  let graceful = false
  if (typeof doFetch === 'function') {
    try {
      const root = new URL(key)
      const href = root.href.endsWith('/') ? root.href : `${root.href}/`
      const auth = String(apiKey ?? '').trim()
      const response = await doFetch(new URL('v1/admin/shutdown', href).toString(), {
        method: 'POST',
        headers: auth === '' ? {} : { authorization: `Bearer ${auth}` },
        signal: AbortSignal.timeout(Math.max(1, graceMs)),
      })
      graceful = response.ok
    } catch { /* 服务已经没了，或者版本老没有这个接口 */ }
  }

  if (!entry.child) {
    // 不是我们拉起来的：只能靠它自己退。graceful 失败就什么都不做。
    return { stopped: graceful, reason: graceful ? 'shutdown-api' : 'not-owned', graceful }
  }

  const child = entry.child
  if (graceful) {
    const exited = await waitChildExit(child, graceMs)
    if (exited) return { stopped: true, reason: 'shutdown-api', graceful: true }
  }
  try { child.kill() } catch { /* 已经退了 */ }
  const exited = await waitChildExit(child, 5000)
  return { stopped: exited, reason: exited ? 'killed' : 'kill-failed', graceful }
}

/** 等子进程退出；超时回 false。 */
function waitChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  // 注入的 spawnImpl 可能给一个只有 kill/unref 的简化对象，没有事件就按「已退」处理。
  if (typeof child.once !== 'function') return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), Math.max(1, Number(timeoutMs) || 5000))
    child.once('exit', () => done(true))
    child.once('error', () => done(false))
  })
}

/** 插件卸载 / 宿主退出时统一收尾：把计时器全清掉，进程交给系统。 */
export function resetFeiyuServices() {
  for (const entry of feiyuServices.values()) clearIdleTimer(entry)
  feiyuServices.clear()
}

/**
 * 确保服务可用：探不通就拉起来，等它通。
 *
 * 同一个地址同时来多个请求时只拉起一次（第二个直接等第一个的结果），
 * 免得两句话各起一个服务抢 9880。
 *
 * @param {{
 *   baseUrl?: string, apiKey?: string,
 *   serverDir?: string, pythonPath?: string, configPath?: string,
 *   autoStart?: boolean,
 *   startTimeoutMs?: number, probeTimeoutMs?: number, idleStopMs?: number,
 *   fetchImpl?: typeof fetch,
 *   spawnImpl?: (spec: { argv: string[], cwd: string, env?: Record<string,string> }) => any,
 *   logger?: { warn?: Function, info?: Function },
 * }} options
 * @returns {Promise<{ ok: boolean, started?: boolean, reason?: string, python?: string }>}
 */
export async function ensureFeiyuService(options) {
  const {
    baseUrl = DEFAULT_FEIYU_BASE_URL,
    apiKey = '',
    serverDir = '',
    pythonPath = '',
    configPath = '',
    autoStart = true,
    startTimeoutMs = DEFAULT_FEIYU_START_TIMEOUT_MS,
    probeTimeoutMs = DEFAULT_FEIYU_PROBE_TIMEOUT_MS,
    idleStopMs = DEFAULT_FEIYU_IDLE_STOP_MINUTES * 60000,
    fetchImpl,
    spawnImpl,
    logger,
  } = options ?? {}

  const key = serviceKey(baseUrl)
  let entry = feiyuServices.get(key)
  if (!entry) {
    entry = { baseUrl: key, apiKey: '', child: null, owned: false, lastUsedAt: 0, timer: null, starting: null, idleStopMs }
    feiyuServices.set(key, entry)
  }
  entry.apiKey = String(apiKey ?? '').trim()
  entry.idleStopMs = Number(idleStopMs)
  // 记住这次用的 fetch：空闲计时器到点时是它自己去停服务，那条路径上没有调用方
  // 传 fetchImpl，只能靠这里存的那一份（否则会退回全局 fetch，测试里会打真网络）。
  if (typeof fetchImpl === 'function') entry.fetchImpl = fetchImpl

  const alive = await probeFeiyuService({ baseUrl: key, timeoutMs: probeTimeoutMs, fetchImpl })
  if (alive.ok) {
    entry.lastUsedAt = Date.now()
    scheduleIdleStop(entry, entry.idleStopMs)
    return { ok: true, started: false, version: alive.version }
  }

  if (autoStart !== true) {
    return { ok: false, reason: `service-down: ${alive.reason ?? 'unreachable'}（自动启动已关闭）` }
  }
  // 已经在拉了：等那一次，别再起第二个。
  if (entry.starting) return await entry.starting

  const dir = String(serverDir ?? '').trim()
  if (dir === '') return { ok: false, reason: 'server-dir-missing' }

  const python = resolvePython(dir, pythonPath)
  if (python === '') return { ok: false, reason: `python-missing: 在 ${dir} 下找不到 python` }

  const cfg = String(configPath ?? '').trim() || join(dir, 'configs', 'voice_service.json')
  let port = '9880'
  let host = '127.0.0.1'
  try {
    const parsed = new URL(key)
    if (parsed.port) port = parsed.port
    if (parsed.hostname) host = parsed.hostname
  } catch { /* 上面探活已经校验过 URL，这里不该失败 */ }

  const argv = [python, '-B', '-m', 'feiyu_voice_service', '--host', host, '--port', port, '--config', cfg]

  const start = (async () => {
    let child = null
    try {
      child = spawnImpl
        ? spawnImpl({ argv, cwd: dir })
        : spawn(argv[0], argv.slice(1), { cwd: dir, windowsHide: true, stdio: 'ignore' })
    } catch (error) {
      return { ok: false, reason: `spawn-failed: ${error?.message ?? error}` }
    }
    entry.child = child ?? null
    entry.owned = true
    if (typeof child?.unref === 'function') child.unref()

    const deadline = Date.now() + Math.max(1000, Number(startTimeoutMs) || DEFAULT_FEIYU_START_TIMEOUT_MS)
    while (Date.now() < deadline) {
      const now = await probeFeiyuService({ baseUrl: key, timeoutMs: probeTimeoutMs, fetchImpl })
      if (now.ok) {
        entry.lastUsedAt = Date.now()
        scheduleIdleStop(entry, entry.idleStopMs)
        logger?.info?.(`肥鱼声音服务已启动（${python}，端口 ${port}）`)
        return { ok: true, started: true, python, version: now.version }
      }
      if (child && (child.exitCode !== null && child.exitCode !== undefined)) {
        return { ok: false, reason: `service-exited: exit=${child.exitCode}` }
      }
      await sleep(700)
    }
    try { child?.kill() } catch { /* 已经退了 */ }
    entry.child = null
    entry.owned = false
    return { ok: false, reason: `start-timeout: ${startTimeoutMs}ms` }
  })()

  entry.starting = start
  try {
    return await start
  } finally {
    entry.starting = null
  }
}

/**
 * 猜 python 解释器。
 *
 * 顺序：设置里填的 → 服务目录下的 `.venv`（Windows 的 `Scripts\python.exe`、
 * 类 Unix 的 `bin/python`）→ 空（让调用方报「找不到 python」，别拿系统 python 乱试：
 * 依赖没装会给出更难懂的错）。
 */
function resolvePython(serverDir, pythonPath) {
  const configured = String(pythonPath ?? '').trim()
  if (configured !== '') return configured
  const candidates = [
    join(serverDir, '.venv', 'Scripts', 'python.exe'),
    join(serverDir, '.venv', 'bin', 'python'),
  ]
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c
    } catch { /* 没权限当不存在 */ }
  }
  return ''
}

/**
 * provider 归一化：只认 `edge` / `sherpa` / `feiyu`，其它（含空）一律回落 `edge`。
 *
 * 回落而不是报错，是为了老配置里没有这个键、或用户手滑填错时，
 * 行为跟以前完全一样 —— 语音照发，只是用的还是 edge。
 */
export function normalizeVoiceProvider(raw) {
  const kind = String(raw ?? '').trim().toLowerCase()
  return VOICE_PROVIDERS.includes(kind) ? kind : DEFAULT_VOICE_PROVIDER
}

/** 语气归一化：只认 `cute` / `gentle`，其它回落 `cute`。 */
export function normalizeFeiyuStyle(raw) {
  return String(raw ?? '').trim().toLowerCase() === 'gentle' ? 'gentle' : 'cute'
}

/**
 * 把正文切成有序片段。
 *
 * 返回 `Array<{ type: 'text' | 'voice', text: string }>`：
 *   - `voice`：`[语音]…[/语音]` 里的话，交给 TTS；标记本身不出现在结果里；
 *   - `text`：其余正文，照旧按表情名拆段发出去。
 *
 * 空片段会被丢掉；连续的空正文不会产生多余段。没有语音标记时，
 * 整个正文就是一个 `text` 片段 —— 调用方可以据此走原来那条快路径。
 *
 * @param {string} body
 * @returns {Array<{ type: 'text' | 'voice', text: string }>}
 */
export function splitVoiceBlocks(body) {
  const text = String(body ?? '')
  const out = []
  let cursor = 0

  for (const m of text.matchAll(VOICE_BLOCK_RE)) {
    const start = m.index ?? 0
    const before = text.slice(cursor, start)
    if (before.trim() !== '') out.push({ type: 'text', text: before })
    const said = String(m[1] ?? '').trim()
    if (said !== '') out.push({ type: 'voice', text: said })
    cursor = start + m[0].length
  }

  const rest = text.slice(cursor)
  if (rest.trim() !== '') out.push({ type: 'text', text: rest })

  // 一个字都没有时也返回空数组，别塞空 text 段。
  return out
}

/** 正文里有没有语音标记（决定要不要走慢路径）。 */
export function hasVoiceBlock(body) {
  return VOICE_BLOCK_RE.test(String(body ?? ''))
}

/** 去掉语音标记之后的纯文本 —— 用来算字数上限、以及降级发文字时的正文。 */
export function stripVoiceBlocks(body) {
  return String(body ?? '').replace(VOICE_BLOCK_RE, '').trim()
}

/**
 * 缓存文件名：同一段话 + 同一套引擎与参数只合成一次。
 *
 * 参与哈希的除了文本，还有**引擎**（edge / sherpa / feiyu）和该引擎自己的参数：
 *   - edge / sherpa：voice / rate / pitch → `.mp3`
 *   - feiyu：voice / style → `.wav`
 * 引擎进哈希 + 后缀不同，三套实现的产物不会互相撞（同一句话各存各的）。
 *
 * 只取前 16 位十六进制，够用且不会把文件名撑长。
 */
export function voiceCacheName(text, { provider = 'edge', voice, rate, pitch, style, ext } = {}) {
  const kind = normalizeVoiceProvider(provider)
  const h = createHash('sha1')
  h.update(kind)
  h.update('\u0000')
  h.update(String(text))
  h.update('\u0000')
  h.update(String(voice ?? ''))
  if (kind === 'feiyu') {
    h.update('\u0000')
    h.update(normalizeFeiyuStyle(style))
    return `${h.digest('hex').slice(0, 16)}.${ext ?? 'wav'}`
  }
  h.update('\u0000')
  h.update(String(rate ?? ''))
  h.update('\u0000')
  h.update(String(pitch ?? ''))
  return `${h.digest('hex').slice(0, 16)}.${ext ?? 'mp3'}`
}

/** 睡一会儿（用于轮询间隔）。 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** 读响应体里的 JSON；不是 JSON 就当没有（不抛）。 */
async function readJsonSafe(response) {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

/**
 * 从响应体里挑出任务号。
 *
 * 字段名各家不一样（`id` / `job_id` / `task_id` / 包一层 `data`），这里宽松认几种，
 * 认不出才算失败 —— 比对端只是字段名不同就整条语音发不出去强。
 */
function pickJobId(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const candidates = [
    payload.id, payload.job_id, payload.jobId, payload.task_id, payload.taskId,
    payload.data?.id, payload.data?.job_id, payload.data?.jobId,
    payload.result?.id, payload.result?.job_id,
  ]
  for (const c of candidates) {
    const s = String(c ?? '').trim()
    if (s !== '') return s
  }
  return ''
}

/** 同上：状态字段可能是 `status` 或 `state`（含包一层 `data`）。 */
function pickJobStatus(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const candidates = [payload.status, payload.state, payload.data?.status, payload.data?.state]
  for (const c of candidates) {
    const s = String(c ?? '').trim()
    if (s !== '') return s.toLowerCase()
  }
  return ''
}

/** 任务失败时的可读原因。 */
function pickJobError(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const candidates = [
    payload.error, payload.message, payload.reason, payload.detail,
    payload.data?.error, payload.data?.message, payload.data?.reason,
  ]
  for (const c of candidates) {
    const s = String(c ?? '').trim()
    if (s !== '') return s.slice(0, 200)
  }
  return ''
}

/** 对端如果直接给了音频地址（`audio_url`），优先用它，省得拼路径猜错。 */
function pickJobAudioUrl(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const candidates = [
    payload.audio_url, payload.audioUrl,
    payload.data?.audio_url, payload.data?.audioUrl,
    payload.result?.audio_url, payload.result?.audioUrl,
  ]
  for (const c of candidates) {
    const s = String(c ?? '').trim()
    if (s !== '') return s
  }
  return ''
}

/**
 * 调肥鱼声音服务合成一段语音。
 *
 * 流程：POST /v1/speech 拿任务号 → 轮询 GET /v1/jobs/{id} → 成功后
 * GET /v1/jobs/{id}/audio（或对端给的 audio_url）下 WAV 落缓存目录，
 * 再用 `ensureRecordAudio()` 转成 mp3（转不了就原样发 WAV，不算失败）。
 *
 * 失败一律落到 `{ok:false, reason}`，调用方据此降级发文字 —— 连不上、鉴权不过、
 * 任务 failed、超时都不抛、不卡死。原因串里**只有状态码与对端给的文字，绝不含 API key**。
 *
 * @param {string} text
 * @param {{
 *   baseUrl?: string, apiKey?: string,
 *   voice?: string, style?: 'cute' | 'gentle',
 *   cacheDir: string, timeoutMs?: number, pollIntervalMs?: number,
 *   ffmpegPath?: string, ffmpegTimeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<
 *   { ok: true, path: string, cached: boolean, wavPath: string, converted: boolean, convertReason?: string }
 *   | { ok: false, reason: string }
 * >} `path` 是**真正发给 OneBot 的那个文件**（转码成功是 mp3，否则是原 WAV）。
 */
export async function feiyuSynthesize(text, options) {
  const said = String(text ?? '').trim()
  if (said === '') return { ok: false, reason: 'empty-text' }

  const {
    baseUrl = DEFAULT_FEIYU_BASE_URL,
    apiKey = '',
    voice = DEFAULT_FEIYU_VOICE,
    style = DEFAULT_FEIYU_STYLE,
    cacheDir,
    timeoutMs = DEFAULT_FEIYU_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_FEIYU_POLL_INTERVAL_MS,
    ffmpegPath = '',
    ffmpegTimeoutMs = DEFAULT_FFMPEG_TIMEOUT_MS,
    serverDir = '',
    pythonPath = '',
    configPath = '',
    autoStart = true,
    startTimeoutMs = DEFAULT_FEIYU_START_TIMEOUT_MS,
    probeTimeoutMs = DEFAULT_FEIYU_PROBE_TIMEOUT_MS,
    idleStopMs = DEFAULT_FEIYU_IDLE_STOP_MINUTES * 60000,
    spawnImpl,
    logger,
    fetchImpl,
  } = options ?? {}

  if (!cacheDir) return { ok: false, reason: 'no-cache-dir' }

  let root
  try {
    root = new URL(String(baseUrl ?? '').trim() || DEFAULT_FEIYU_BASE_URL)
  } catch {
    return { ok: false, reason: 'bad-base-url' }
  }
  if (root.protocol !== 'http:' && root.protocol !== 'https:') {
    return { ok: false, reason: `bad-base-url: ${root.protocol}` }
  }

  try {
    mkdirSync(cacheDir, { recursive: true })
  } catch (error) {
    return { ok: false, reason: `cache-dir-unusable: ${error?.message ?? error}` }
  }

  const saidStyle = normalizeFeiyuStyle(style)
  const saidVoice = String(voice ?? '').trim() || DEFAULT_FEIYU_VOICE
  const outPath = join(cacheDir, voiceCacheName(said, { provider: 'feiyu', voice: saidVoice, style: saidStyle }))
  const wavReady = existsSync(outPath) && statSync(outPath).size > 0

  /** 产物落定后统一收尾：能转 mp3 就转，转不了照发 WAV。 */
  const finish = async (cached) => {
    const audio = await ensureRecordAudio(outPath, { ffmpegPath, timeoutMs: ffmpegTimeoutMs })
    return {
      ok: true,
      path: audio.path,
      cached,
      wavPath: outPath,
      converted: audio.converted === true,
      ...(audio.reason ? { convertReason: audio.reason } : {}),
    }
  }

  // 同一句话 + 同音色 + 同语气：缓存里有就不再打扰服务。
  // 但仍然算一次「使用」——否则整句都命中缓存时，服务会一直没被重置计时器而提前停掉。
  if (wavReady) {
    noteFeiyuActivity({ baseUrl, idleStopMs })
    return await finish(true)
  }

  // 服务没起就先拉起来（`serverDir` 为空 = 用户没配自动启动，直接探活失败后报错）。
  const ready = await ensureFeiyuService({
    baseUrl,
    apiKey,
    serverDir,
    pythonPath,
    configPath,
    autoStart: autoStart !== false,
    startTimeoutMs,
    probeTimeoutMs,
    idleStopMs,
    fetchImpl,
    spawnImpl,
    logger,
  })
  if (!ready.ok) return { ok: false, reason: ready.reason ?? 'service-unavailable' }

  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return { ok: false, reason: 'no-fetch' }

  const budgetMs = Math.max(1, Math.floor(Number(timeoutMs) || DEFAULT_FEIYU_TIMEOUT_MS))
  const gapMs = Math.max(1, Math.floor(Number(pollIntervalMs) || DEFAULT_FEIYU_POLL_INTERVAL_MS))
  const deadline = Date.now() + budgetMs
  const remaining = () => deadline - Date.now()
  const timedOut = () => ({ ok: false, reason: `timeout: ${budgetMs}ms` })

  const auth = String(apiKey ?? '').trim()
  const authHeaders = auth === '' ? {} : { authorization: `Bearer ${auth}` }
  const jsonHeaders = { ...authHeaders, 'content-type': 'application/json' }

  // baseUrl 末尾有没有斜杠都能用，也允许带一段前缀（如 http://host/feiyu）。
  const baseHref = root.href.endsWith('/') ? root.href : `${root.href}/`
  const url = (path) => new URL(String(path).replace(/^\//, ''), baseHref).toString()

  /** 发一个请求；超时/连不上都翻译成 reason，不往上抛。 */
  async function request(target, init) {
    const left = remaining()
    if (left <= 0) return { ok: false, reason: `timeout: ${budgetMs}ms` }
    try {
      const response = await doFetch(target, { ...init, signal: AbortSignal.timeout(Math.max(1, left)) })
      return { ok: true, response }
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return timedOut()
      const code = error?.cause?.code ?? error?.code ?? ''
      const msg = String(error?.message ?? error)
      return { ok: false, reason: `connect-failed: ${code ? `${code}: ` : ''}${msg}` }
    }
  }

  /** 401/403 → 鉴权；其余非 2xx → 带状态码。 */
  function httpReason(response, kind, acceptStatus) {
    if (response.status === 401 || response.status === 403) return `auth-failed: ${response.status}`
    if (!acceptStatus.includes(response.status) && !(response.status >= 200 && response.status < 300)) {
      return `${kind}-http-${response.status}`
    }
    return ''
  }

  // 1) 提交任务
  const submit = await request(url('/v1/speech'), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ voice: saidVoice, text: said, style: saidStyle }),
  })
  if (!submit.ok) return submit
  const submitReason = httpReason(submit.response, 'speech', [202])
  if (submitReason) return { ok: false, reason: submitReason }
  const submitPayload = await readJsonSafe(submit.response)
  const jobId = pickJobId(submitPayload)
  if (jobId === '') return { ok: false, reason: 'no-job-id' }
  let audioUrl = pickJobAudioUrl(submitPayload)

  // 2) 轮询状态
  const jobUrl = url(`/v1/jobs/${encodeURIComponent(jobId)}`)
  for (;;) {
    const poll = await request(jobUrl, { method: 'GET', headers: authHeaders })
    if (!poll.ok) return poll
    const pollReason = httpReason(poll.response, 'job', [])
    if (pollReason) return { ok: false, reason: pollReason }
    const payload = await readJsonSafe(poll.response)
    const status = pickJobStatus(payload)
    if (status === 'success' || status === 'succeeded' || status === 'done' || status === 'completed') {
      audioUrl = pickJobAudioUrl(payload) || audioUrl
      break
    }
    if (status === 'failed' || status === 'error') {
      return { ok: false, reason: `job-failed: ${pickJobError(payload) || 'unknown'}` }
    }
    if (status === 'interrupted' || status === 'cancelled' || status === 'canceled') {
      return { ok: false, reason: `job-${status}` }
    }
    // queued / running / pending / 认不出的状态：还用得着等，睡一个轮询间隔再看。
    if (remaining() <= 0) return timedOut()
    await sleep(Math.min(gapMs, Math.max(1, remaining())))
  }

  // 3) 下音频（对端给了完整地址就用它，否则按约定路径拼）
  const audioTarget = audioUrl === ''
    ? url(`/v1/jobs/${encodeURIComponent(jobId)}/audio`)
    : (/^https?:\/\//i.test(audioUrl) ? audioUrl : url(audioUrl))
  const audio = await request(audioTarget, { method: 'GET', headers: authHeaders })
  if (!audio.ok) return audio
  const audioReason = httpReason(audio.response, 'audio', [])
  if (audioReason) return { ok: false, reason: audioReason }

  let buf
  try {
    buf = Buffer.from(await audio.response.arrayBuffer())
  } catch (error) {
    return { ok: false, reason: `audio-read-failed: ${error?.message ?? error}` }
  }
  if (buf.length === 0) return { ok: false, reason: 'audio-empty' }
  try {
    writeFileSync(outPath, buf)
  } catch (error) {
    return { ok: false, reason: `cache-write-failed: ${error?.message ?? error}` }
  }
  noteFeiyuActivity({ baseUrl, idleStopMs })
  return await finish(false)
}

/**
 * 调肥鱼声音服务「按谱唱歌」。
 *
 * 唱歌比说话多两步：先把**谱子**（ABC / MIDI）和**歌词**传成资源，再提交任务；
 * 服务端拿谱面主旋律 + 歌词逐字对齐 → SVS 出声 → RVC 换成肥鱼的声音。
 * 谱子只收单音主旋律，一字一音，一字多音用 `_` 占位（这是上游模型的规矩）。
 *
 * 与 `feiyuSynthesize()` 共用同一套鉴权 / 轮询 / 下载 / 转码逻辑，
 * 失败同样只回 `{ok:false, reason}`，原因串里绝不含 API key。
 *
 * @param {{
 *   score: string, scoreBase64?: string, scoreName?: string,
 *   lyrics?: string, pinyin?: string,
 *   transpose?: number, bpm?: number, segmentSeconds?: number,
 *   baseUrl?: string, apiKey?: string, voice?: string,
 *   cacheDir: string, cacheKey?: string,
 *   timeoutMs?: number, pollIntervalMs?: number,
 *   ffmpegPath?: string, ffmpegTimeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 * }} options `score` 是 ABC 或 MIDI 的**文本**；MIDI 二进制请转成 base64 后用 `scoreBase64` 传。
 * @returns {Promise<
 *   { ok: true, path: string, cached: boolean, wavPath: string, converted: boolean, seconds?: number }
 *   | { ok: false, reason: string }
 * >}
 */
export async function feiyuSing(options) {
  const {
    score = '',
    scoreBase64 = '',
    scoreName = 'score.abc',
    lyrics,
    pinyin,
    transpose = 0,
    bpm,
    segmentSeconds,
    baseUrl = DEFAULT_FEIYU_BASE_URL,
    apiKey = '',
    voice = DEFAULT_FEIYU_VOICE,
    cacheDir,
    cacheKey = '',
    timeoutMs = DEFAULT_FEIYU_SING_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_FEIYU_POLL_INTERVAL_MS,
    ffmpegPath = '',
    ffmpegTimeoutMs = DEFAULT_FFMPEG_TIMEOUT_MS,
    serverDir = '',
    pythonPath = '',
    configPath = '',
    autoStart = true,
    startTimeoutMs = DEFAULT_FEIYU_START_TIMEOUT_MS,
    probeTimeoutMs = DEFAULT_FEIYU_PROBE_TIMEOUT_MS,
    idleStopMs = DEFAULT_FEIYU_IDLE_STOP_MINUTES * 60000,
    spawnImpl,
    logger,
    fetchImpl,
  } = options ?? {}

  const scoreBytes = scoreBase64 !== ''
    ? Buffer.from(String(scoreBase64), 'base64')
    : Buffer.from(String(score ?? ''), 'utf8')
  // 谱子既可以给文本（score）也可以给 base64（scoreBase64）；给文本时纯空白算空。
  const gotBase64 = scoreBase64 !== '' && scoreBytes.length > 0
  if (!gotBase64 && String(score ?? '').trim() === '') {
    return { ok: false, reason: 'empty-score' }
  }
  if (String(lyrics ?? '').trim() === '' && String(pinyin ?? '').trim() === '') {
    return { ok: false, reason: 'no-lyrics' }
  }
  if (!cacheDir) return { ok: false, reason: 'no-cache-dir' }

  let root
  try {
    root = new URL(String(baseUrl ?? '').trim() || DEFAULT_FEIYU_BASE_URL)
  } catch {
    return { ok: false, reason: 'bad-base-url' }
  }
  if (root.protocol !== 'http:' && root.protocol !== 'https:') {
    return { ok: false, reason: `bad-base-url: ${root.protocol}` }
  }
  try {
    mkdirSync(cacheDir, { recursive: true })
  } catch (error) {
    return { ok: false, reason: `cache-dir-unusable: ${error?.message ?? error}` }
  }

  const saidVoice = String(voice ?? '').trim() || DEFAULT_FEIYU_VOICE
  const digestKey = cacheKey !== '' ? cacheKey : `${scoreName}|${cacheKeyOfScore(scoreBytes)}|${String(lyrics ?? '')}|${String(pinyin ?? '')}`
  const outPath = join(cacheDir, `${createHash('sha1').update('feiyu-sing\u0000').update(digestKey).update('\u0000').update(saidVoice).digest('hex').slice(0, 16)}.wav`)

  const finish = async (cached, seconds) => {
    const audio = await ensureRecordAudio(outPath, { ffmpegPath, timeoutMs: ffmpegTimeoutMs })
    return {
      ok: true,
      path: audio.path,
      cached,
      wavPath: outPath,
      converted: audio.converted === true,
      ...(seconds ? { seconds } : {}),
      ...(audio.reason ? { convertReason: audio.reason } : {}),
    }
  }

  if (existsSync(outPath) && statSync(outPath).size > 0) {
    noteFeiyuActivity({ baseUrl, idleStopMs })
    return await finish(true)
  }

  const ready = await ensureFeiyuService({
    baseUrl,
    apiKey,
    serverDir,
    pythonPath,
    configPath,
    autoStart: autoStart !== false,
    startTimeoutMs,
    probeTimeoutMs,
    idleStopMs,
    fetchImpl,
    spawnImpl,
    logger,
  })
  if (!ready.ok) return { ok: false, reason: ready.reason ?? 'service-unavailable' }

  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return { ok: false, reason: 'no-fetch' }

  const budgetMs = Math.max(1, Math.floor(Number(timeoutMs) || DEFAULT_FEIYU_SING_TIMEOUT_MS))
  const gapMs = Math.max(1, Math.floor(Number(pollIntervalMs) || DEFAULT_FEIYU_POLL_INTERVAL_MS))
  const deadline = Date.now() + budgetMs
  const remaining = () => deadline - Date.now()
  const timedOut = () => ({ ok: false, reason: `timeout: ${budgetMs}ms` })

  const auth = String(apiKey ?? '').trim()
  const authHeaders = auth === '' ? {} : { authorization: `Bearer ${auth}` }
  const jsonHeaders = { ...authHeaders, 'content-type': 'application/json' }
  const baseHref = root.href.endsWith('/') ? root.href : `${root.href}/`
  const url = (path) => new URL(String(path).replace(/^\//, ''), baseHref).toString()

  async function request(target, init) {
    const left = remaining()
    if (left <= 0) return { ok: false, reason: `timeout: ${budgetMs}ms` }
    try {
      const response = await doFetch(target, { ...init, signal: AbortSignal.timeout(Math.max(1, left)) })
      return { ok: true, response }
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return timedOut()
      const code = error?.cause?.code ?? error?.code ?? ''
      const msg = String(error?.message ?? error)
      return { ok: false, reason: `connect-failed: ${code ? `${code}: ` : ''}${msg}` }
    }
  }

  function httpReason(response, kind, acceptStatus) {
    if (response.status === 401 || response.status === 403) return `auth-failed: ${response.status}`
    if (!acceptStatus.includes(response.status) && !(response.status >= 200 && response.status < 300)) {
      return `${kind}-http-${response.status}`
    }
    return ''
  }

  /** 传一份文本资源（谱子 / 歌词 / 拼音），换回资源 id。 */
  async function upload(bytes, filename, kind) {
    let form
    try {
      form = new FormData()
      form.append('file', new Blob([bytes]), filename)
    } catch (error) {
      return { ok: false, reason: `form-unavailable: ${error?.message ?? error}` }
    }
    const sent = await request(url('/v1/assets'), { method: 'POST', headers: authHeaders, body: form })
    if (!sent.ok) return sent
    const reason = httpReason(sent.response, kind, [201])
    if (reason) return { ok: false, reason }
    const payload = await readJsonSafe(sent.response)
    const id = String(payload?.id ?? '').trim()
    if (id === '') return { ok: false, reason: `no-${kind}-id` }
    return { ok: true, id }
  }

  const uploadScore = await upload(scoreBytes, scoreName, 'score')
  if (!uploadScore.ok) return uploadScore
  const uploadLyrics = await upload(Buffer.from(String(lyrics ?? ''), 'utf8'), 'lyrics.txt', 'lyrics')
  if (!uploadLyrics.ok) return uploadLyrics

  const body = { voice: saidVoice, score_id: uploadScore.id, lyrics_id: uploadLyrics.id }
  if (String(pinyin ?? '').trim() !== '') {
    const uploadPinyin = await upload(Buffer.from(String(pinyin), 'utf8'), 'pinyin.txt', 'pinyin')
    if (!uploadPinyin.ok) return uploadPinyin
    body.pinyin_id = uploadPinyin.id
  }
  if (Number.isFinite(Number(transpose)) && Number(transpose) !== 0) body.transpose = Math.trunc(Number(transpose))
  if (Number.isFinite(Number(bpm)) && Number(bpm) > 0) body.bpm = Number(bpm)
  if (Number.isFinite(Number(segmentSeconds)) && Number(segmentSeconds) > 0) body.segment_seconds = Number(segmentSeconds)

  const submit = await request(url('/v1/singing'), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  })
  if (!submit.ok) return submit
  const submitReason = httpReason(submit.response, 'singing', [202])
  if (submitReason) return { ok: false, reason: submitReason }
  const submitPayload = await readJsonSafe(submit.response)
  const jobId = pickJobId(submitPayload)
  if (jobId === '') return { ok: false, reason: 'no-job-id' }
  let audioUrl = pickJobAudioUrl(submitPayload)

  const jobUrl = url(`/v1/jobs/${encodeURIComponent(jobId)}`)
  let seconds
  for (;;) {
    const poll = await request(jobUrl, { method: 'GET', headers: authHeaders })
    if (!poll.ok) return poll
    const pollReason = httpReason(poll.response, 'job', [])
    if (pollReason) return { ok: false, reason: pollReason }
    const payload = await readJsonSafe(poll.response)
    const status = pickJobStatus(payload)
    if (status === 'success' || status === 'succeeded' || status === 'done' || status === 'completed') {
      audioUrl = pickJobAudioUrl(payload) || audioUrl
      seconds = Number(payload?.audio?.seconds)
      break
    }
    if (status === 'failed' || status === 'error') {
      return { ok: false, reason: `job-failed: ${pickJobError(payload) || 'unknown'}` }
    }
    if (status === 'interrupted' || status === 'cancelled' || status === 'canceled') {
      return { ok: false, reason: `job-${status}` }
    }
    if (remaining() <= 0) return timedOut()
    await sleep(Math.min(gapMs, Math.max(1, remaining())))
  }

  const audioTarget = audioUrl === ''
    ? url(`/v1/jobs/${encodeURIComponent(jobId)}/audio`)
    : (/^https?:\/\//i.test(audioUrl) ? audioUrl : url(audioUrl))
  const audio = await request(audioTarget, { method: 'GET', headers: authHeaders })
  if (!audio.ok) return audio
  const audioReason = httpReason(audio.response, 'audio', [])
  if (audioReason) return { ok: false, reason: audioReason }
  let buf
  try {
    buf = Buffer.from(await audio.response.arrayBuffer())
  } catch (error) {
    return { ok: false, reason: `audio-read-failed: ${error?.message ?? error}` }
  }
  if (buf.length === 0) return { ok: false, reason: 'audio-empty' }
  try {
    writeFileSync(outPath, buf)
  } catch (error) {
    return { ok: false, reason: `cache-write-failed: ${error?.message ?? error}` }
  }
  noteFeiyuActivity({ baseUrl, idleStopMs })
  return await finish(false, seconds)
}

/** 谱子文本的短指纹（只用于缓存键，不是完整性校验）。 */
function cacheKeyOfScore(bytes) {
  return createHash('sha1').update(bytes).digest('hex').slice(0, 16)
}

/**
 * 把合成产物变成「NapCat 稳吃的」音频路径。
 *
 * 实测 NapCat 吃 mp3；肥鱼服务产的是 WAV，所以这里用本机 ffmpeg 转一份 mp3。
 * 找 ffmpeg 的顺序：设置的 `ffmpegPath` →（没填时）环境变量 `DSH_TTS_FFMPEG`
 * → PATH 上的 `ffmpeg`。**不再内置任何本机绝对路径** —— 那是装插件的人机器上
 * 不存在的位置，写死只会让「别人的机器也能用」变成一句空话。
 * 规则：不是 wav 就原样返回；是 wav 才试着转，**都找不到 / 转失败就回落到原 WAV**
 * （而不是当作合成失败）—— 能发出去总比因为转码工具没装就降级发文字好。
 * 任何一步都不抛。
 *
 * @param {string} absPath
 * @param {{ ffmpegPath?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ path: string, converted: boolean, reason?: string }>}
 */
export async function ensureRecordAudio(absPath, options) {
  const src = String(absPath ?? '')
  if (src === '') return { path: '', converted: false, reason: 'empty-path' }
  if (!/\.wav$/i.test(src)) return { path: src, converted: false }

  const { ffmpegPath = '', timeoutMs = DEFAULT_FFMPEG_TIMEOUT_MS } = options ?? {}
  const dst = src.replace(/\.wav$/i, '.mp3')

  // 上次已经转过就直接用（同一句话重复发不重复转码）。
  try {
    if (existsSync(dst) && statSync(dst).size > 0) return { path: dst, converted: true }
  } catch { /* 读不了当没转过 */ }

  const configured = String(ffmpegPath ?? '').trim()
  const candidates = configured !== ''
    ? [configured]
    : [process.env.DSH_TTS_FFMPEG || '', 'ffmpeg'].filter((x) => x !== '')

  let lastReason = 'ffmpeg-missing: 找不到可用的 ffmpeg'
  for (const bin of candidates) {
    const result = await runFfmpeg(bin, src, dst, timeoutMs)
    if (result.ok) {
      try {
        if (!existsSync(dst) || statSync(dst).size === 0) {
          lastReason = 'ffmpeg-produced-nothing'
          continue
        }
      } catch {
        lastReason = 'ffmpeg-produced-nothing'
        continue
      }
      return { path: dst, converted: true }
    }
    lastReason = result.reason
    // 只是「这个位置没有 ffmpeg」才继续试下一个；真跑起来报错就到此为止。
    if (!/^ffmpeg-(missing|spawn-failed)/.test(String(result.reason ?? ''))) break
  }
  return { path: src, converted: false, reason: lastReason }
}

/**
 * 语音转码用的滤镜链。
 *
 * 干、薄、忽大忽小，是「TTS 直出」听起来的通病；这一串都是很轻的手：
 *   - highpass 80 / lowpass 12000：掐掉低频嗡声与齿音外的毛刺；
 *   - 200Hz +1.5dB、3000Hz +1.5dB：补一点胸腔与清晰度，不至于发闷或刺耳；
 *   - acompressor：把忽大忽小的音量压平（阈值 -18dB、比 2.5，轻压不糊）；
 *   - loudnorm：整体拉到 -16 LUFS / 峰值 -1.5dBTP，跟常见语音内容一个响度。
 *
 * 注意 loudnorm 内部会升到 192kHz 采样，所以后面必须显式 `-ar` 收回来，
 * 否则 libmp3lame 编不出来。
 */
export const VOICE_FILTER_CHAIN = [
  'highpass=f=80',
  'lowpass=f=12000',
  'equalizer=f=200:t=q:w=1:g=1.5',
  'equalizer=f=3000:t=q:w=1.5:g=1.5',
  'acompressor=threshold=-18dB:ratio=2.5:attack=10:release=150',
  'loudnorm=I=-16:TP=-1.5:LRA=11',
].join(',')
/** 转码输出的采样率与码率。语音 96k 足够，再高只是白占体积。 */
export const VOICE_OUTPUT_SAMPLE_RATE = 44100
export const VOICE_OUTPUT_BITRATE = '96k'

/**
 * 跑一次 ffmpeg 把 wav 转成 mp3。**不抛**，失败回 `{ok:false, reason}`。
 *
 * 滤镜失败（老版本 ffmpeg 缺某个滤镜）时**退一步**用最朴素的方式再转一次：
 * 宁可音色差一点，也别因为滤镜不支持就发不出声音。
 *
 * @param {string} bin
 * @param {string} src
 * @param {string} dst
 * @param {number} timeoutMs
 */
async function runFfmpeg(bin, src, dst, timeoutMs) {
  const encode = ['-ar', String(VOICE_OUTPUT_SAMPLE_RATE), '-codec:a', 'libmp3lame', '-b:a', VOICE_OUTPUT_BITRATE, dst]
  const first = await runFfmpegOnce(bin, ['-y', '-i', src, '-af', VOICE_FILTER_CHAIN, ...encode], timeoutMs)
  if (first.ok) return first
  // 滤镜链跑不动（缺滤镜 / 参数不被支持）才退；找不到 ffmpeg 就没必要再试一遍。
  if (/^ffmpeg-(missing|spawn-failed|timeout)/.test(String(first.reason ?? ''))) return first
  const plain = await runFfmpegOnce(bin, ['-y', '-i', src, ...encode], timeoutMs)
  if (plain.ok) return { ok: true, filtered: false }
  return plain
}

/** 跑一次 ffmpeg（给定的完整参数）。**不抛**。 */
async function runFfmpegOnce(bin, args, timeoutMs) {
  return await new Promise((resolve) => {
    let settled = false
    let stderr = ''
    let child
    try {
      child = spawn(bin, args, {
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, reason: `ffmpeg-spawn-failed: ${error?.message ?? error}` })
      return
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* 已经退出了 */ }
      resolve({ ok: false, reason: `ffmpeg-timeout: ${timeoutMs}ms` })
    }, Math.max(1, Math.floor(Number(timeoutMs) || DEFAULT_FFMPEG_TIMEOUT_MS)))
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, reason: `ffmpeg-missing: ${error?.message ?? error}` })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        resolve({ ok: false, reason: `ffmpeg-exit-${code}: ${stderr.trim().slice(-200)}` })
        return
      }
      resolve({ ok: true, filtered: true })
    })
  })
}

/**
 * 调本地 TTS 合成一段语音。
 *
 * `provider` 三选一：
 *   - `edge`（默认）：调 edge-tts，吐 mp3；
 *   - `sherpa`：调本机 sherpa-onnx 的离线 VITS 模型，吐 mp3（不联网）；
 *   - `feiyu`：转调 `feiyuSynthesize()`（HTTP 服务，吐 wav，会顺手转 mp3）。
 * 认不出的值直接失败（让调用方降级），**不会**偷偷拿别的引擎顶着。
 *
 * 文本走**环境变量**传给 python，不走命令行参数：
 * 中文 + 标点 + 引号在 Windows 命令行上很容易被拆坏，环境变量是 UTF-8 可靠的。
 *
 * @param {string} text
 * @param {{
 *   provider?: 'edge' | 'sherpa' | 'feiyu',
 *   pythonPath?: string,
 *   modelDir?: string, sid?: number, speed?: number,
 *   voice?: string, rate?: string, pitch?: string,
 *   baseUrl?: string, apiKey?: string, style?: 'cute' | 'gentle',
 *   ffmpegPath?: string,
 *   cacheDir: string,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<{ ok: true, path: string, cached: boolean } | { ok: false, reason: string }>}
 */
export async function synthesize(text, options) {
  const said = String(text ?? '').trim()
  if (said === '') return { ok: false, reason: 'empty-text' }

  // 肥鱼走 HTTP，超时/轮询参数跟子进程那套完全不同，所以先分派出去再解构。
  if (normalizeVoiceProvider(options?.provider) === 'feiyu') {
    // 自动启停那几个键从设置里下来时带 `feiyu` 前缀（避免和 edge/sherpa 的
    // `pythonPath` 撞名），这里换成 feiyuSynthesize 认的无前缀名。
    // **`feiyu*` 必须覆盖同名无前缀键**：index.js 无论哪个引擎都会把 edge 的
    // `pythonPath`（ttsPythonPath）一起传下来，若只在「无前缀为空」时才映射，
    // 肥鱼就会拿着 edge 那个 venv 去起服务 —— 找不到 `feiyu_voice_service` 模块，
    // 直接 exit=1。踩过。
    const o = options ?? {}
    return await feiyuSynthesize(said, {
      ...o,
      ...(o.feiyuServerDir !== undefined ? { serverDir: o.feiyuServerDir } : {}),
      ...(o.feiyuPythonPath !== undefined ? { pythonPath: o.feiyuPythonPath } : {}),
      ...(o.feiyuAutoStart !== undefined ? { autoStart: o.feiyuAutoStart } : {}),
      ...(o.feiyuIdleStopMs !== undefined ? { idleStopMs: o.feiyuIdleStopMs } : {}),
    })
  }

  const {
    provider = 'edge',
    pythonPath = '',
    modelDir = '',
    sid = 0,
    speed = 1,
    voice = DEFAULT_TTS_VOICE,
    rate = DEFAULT_TTS_RATE,
    pitch = DEFAULT_TTS_PITCH,
    cacheDir,
    timeoutMs = DEFAULT_TTS_TIMEOUT_MS,
  } = options ?? {}

  const kind = String(provider ?? 'edge').trim().toLowerCase() || 'edge'
  /** 两种引擎最后都出 mp3：NapCat 收 mp3 直传最稳，缓存文件也能混着放。 */
  const ext = 'mp3'

  if (!cacheDir) return { ok: false, reason: 'no-cache-dir' }

  try {
    mkdirSync(cacheDir, { recursive: true })
  } catch (error) {
    return { ok: false, reason: `cache-dir-unusable: ${error?.message ?? error}` }
  }

  const outPath = join(cacheDir, voiceCacheName(said, { provider: kind, voice, rate, pitch, ext }))
  if (existsSync(outPath) && statSync(outPath).size > 0) {
    return { ok: true, path: outPath, cached: true }
  }

  // 固定的 python 端脚本（纯 ASCII，避免命令行编码问题）。
  const edgeScript = [
    'import asyncio, os, sys',
    'import edge_tts',
    'async def main():',
    '    c = edge_tts.Communicate(os.environ["DSH_TTS_TEXT"],',
    '                             os.environ["DSH_TTS_VOICE"],',
    '                             rate=os.environ.get("DSH_TTS_RATE", "+0%"),',
    '                             pitch=os.environ.get("DSH_TTS_PITCH", "+0Hz"))',
    '    await c.save(os.environ["DSH_TTS_OUT"])',
    'asyncio.run(main())',
  ].join('\n')

  // 本地离线：sherpa-onnx 跑中文 VITS 模型，出 PCM 再用 lameenc 编成 mp3（不联网）。
  const sherpaScript = [
    'import os, array',
    'import sherpa_onnx, lameenc',
    'md = os.environ["DSH_TTS_MODEL_DIR"]',
    'def p(n):',
    '    q = os.path.join(md, n)',
    '    return q if os.path.exists(q) else ""',
    'vits = sherpa_onnx.OfflineTtsVitsModelConfig(',
    '    model=os.path.join(md, "model.onnx"),',
    '    lexicon=p("lexicon.txt"),',
    '    tokens=p("tokens.txt"),',
    '    dict_dir=(os.path.join(md, "dict") if os.path.isdir(os.path.join(md, "dict")) else ""),',
    ')',
    'cfg = sherpa_onnx.OfflineTtsConfig(',
    '    model=sherpa_onnx.OfflineTtsModelConfig(vits=vits, num_threads=2, debug=False, provider="cpu"))',
    'tts = sherpa_onnx.OfflineTts(cfg)',
    'audio = tts.generate(os.environ["DSH_TTS_TEXT"],',
    '                     sid=int(os.environ.get("DSH_TTS_SID", "0")),',
    '                     speed=float(os.environ.get("DSH_TTS_SPEED", "1.0")))',
    'vals = [int(max(-32768, min(32767, s * 32767))) for s in audio.samples]',
    'raw = array.array("h", vals).tobytes()',
    'enc = lameenc.Encoder()',
    'enc.set_bit_rate(64)',
    'enc.set_in_sample_rate(int(audio.sample_rate))',
    'enc.set_channels(1)',
    'enc.set_quality(2)',
    'data = enc.encode(raw) + enc.flush()',
    'open(os.environ["DSH_TTS_OUT"], "wb").write(data)',
  ].join('\n')

  const script = kind === 'sherpa' ? sherpaScript : edgeScript
  if (kind !== 'sherpa' && kind !== 'edge') {
    return { ok: false, reason: `unsupported-tts-provider: ${kind}` }
  }
  if (kind === 'sherpa' && !String(modelDir ?? '').trim()) {
    return { ok: false, reason: 'sherpa-model-dir-missing' }
  }

  const python = pythonPath || process.env.DSH_TTS_PYTHON || 'python'

  const result = await new Promise((resolve) => {
    let settled = false
    let stderr = ''
    let child
    try {
      child = spawn(python, ['-c', script], {
        env: {
          ...process.env,
          DSH_TTS_TEXT: said,
          DSH_TTS_OUT: outPath,
          DSH_TTS_VOICE: voice,
          DSH_TTS_RATE: rate,
          DSH_TTS_PITCH: pitch,
          DSH_TTS_MODEL_DIR: String(modelDir ?? ''),
          DSH_TTS_SID: String(sid ?? 0),
          DSH_TTS_SPEED: String(speed ?? 1),
        },
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, reason: `spawn-failed: ${error?.message ?? error}` })
      return
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* 已经退出了 */ }
      resolve({ ok: false, reason: `timeout: ${timeoutMs}ms` })
    }, timeoutMs)

    // edge-tts 的进度提示走 stderr；只在失败时用到。
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, reason: `spawn-error: ${error?.message ?? error}` })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        resolve({ ok: false, reason: `tts-exit-${code}: ${stderr.trim().slice(-300)}` })
        return
      }
      if (!existsSync(outPath) || statSync(outPath).size === 0) {
        resolve({ ok: false, reason: 'tts-produced-nothing' })
        return
      }
      resolve({ ok: true, path: outPath, cached: false })
    })
  })

  return result
}

/**
 * mp3 路径 → OneBot record 段的 data。
 *
 * 用 `file:///` 绝对路径而不是 base64：实测两者 NapCat 都吃，但 base64 会把体积
 * 放大 4/3 塞进 WebSocket 帧，长句更明显；本地文件帧更小，失败还能直接回放排查。
 *
 * @param {string} absPath
 */
export function recordSegment(absPath) {
  const normalized = String(absPath).replace(/\\/g, '/')
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return { type: 'record', data: { file: `file://${withSlash}` } }
}
