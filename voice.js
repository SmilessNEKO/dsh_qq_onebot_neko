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
 * 找不到 ffmpeg 时最后试一次的本机路径。
 *
 * 本机 ffmpeg 常被放在 PATH 之外（例如随某套工具一起解压出来的），
 * 这里给一个约定位置兜底；设置的 `ffmpegPath` 一旦填了就只用填的那个。
 */
export const FFMPEG_FALLBACK_PATH = 'D:\\小丸\\tools\\ffmpeg.exe'

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
  if (wavReady) return await finish(true)

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

  if (existsSync(outPath) && statSync(outPath).size > 0) return await finish(true)

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
 * → PATH 上的 `ffmpeg` → `FFMPEG_FALLBACK_PATH`。
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
    : [process.env.DSH_TTS_FFMPEG || '', 'ffmpeg', FFMPEG_FALLBACK_PATH].filter((x) => x !== '')

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
 * 跑一次 ffmpeg 把 wav 转成 mp3。**不抛**，失败回 `{ok:false, reason}`。
 *
 * @param {string} bin
 * @param {string} src
 * @param {string} dst
 * @param {number} timeoutMs
 */
async function runFfmpeg(bin, src, dst, timeoutMs) {
  return await new Promise((resolve) => {
    let settled = false
    let stderr = ''
    let child
    try {
      child = spawn(bin, ['-y', '-i', src, '-codec:a', 'libmp3lame', '-b:a', '64k', dst], {
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
      resolve({ ok: true })
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
    return await feiyuSynthesize(said, options)
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
