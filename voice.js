// voice.js — 出站语音：把「[语音]台词[/语音]」拆出来、合成 mp3、组 OneBot record 段。
//
// 分工：
//   * `splitVoiceBlocks()` 纯函数，负责把一段正文切成有序的 text / voice 片段；
//   * `synthesize()` 负责调本地 TTS 生成 mp3（默认 edge-tts，子进程调用）；
//   * `recordSegment()` 把 mp3 路径变成 OneBot 的 record 段。
//
// 为什么不自己转 silk：NapCat 收到 mp3 会自己转码（实测 mp3 直传 retcode 0）。
// 换成别的 OneBot 实现、对方不吃 mp3 时，再在这里补 silk-wasm 转码。

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
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
/** 合成超时。edge-tts 正常 1–2 秒出一句，给足余量但别无限等。 */
export const DEFAULT_TTS_TIMEOUT_MS = 20000

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
 * 缓存文件名：同一段话 + 同一套音色参数只合成一次。
 *
 * 只取前 16 位十六进制，够用且不会把文件名撑长。
 */
export function voiceCacheName(text, { voice, rate, pitch } = {}) {
  const h = createHash('sha1')
  h.update(String(text))
  h.update('\u0000')
  h.update(String(voice ?? ''))
  h.update('\u0000')
  h.update(String(rate ?? ''))
  h.update('\u0000')
  h.update(String(pitch ?? ''))
  return `${h.digest('hex').slice(0, 16)}.mp3`
}

/**
 * 调 edge-tts 合成一段语音，返回 mp3 的绝对路径。
 *
 * 文本走**环境变量**传给 python，不走命令行参数：
 * 中文 + 标点 + 引号在 Windows 命令行上很容易被拆坏，环境变量是 UTF-8 可靠的。
 *
 * @param {string} text
 * @param {{
 *   pythonPath?: string,
 *   voice?: string, rate?: string, pitch?: string,
 *   cacheDir: string,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<{ ok: true, path: string, cached: boolean } | { ok: false, reason: string }>}
 */
export async function synthesize(text, options) {
  const said = String(text ?? '').trim()
  if (said === '') return { ok: false, reason: 'empty-text' }

  const {
    pythonPath = '',
    voice = DEFAULT_TTS_VOICE,
    rate = DEFAULT_TTS_RATE,
    pitch = DEFAULT_TTS_PITCH,
    cacheDir,
    timeoutMs = DEFAULT_TTS_TIMEOUT_MS,
  } = options ?? {}

  if (!cacheDir) return { ok: false, reason: 'no-cache-dir' }

  try {
    mkdirSync(cacheDir, { recursive: true })
  } catch (error) {
    return { ok: false, reason: `cache-dir-unusable: ${error?.message ?? error}` }
  }

  const outPath = join(cacheDir, voiceCacheName(said, { voice, rate, pitch }))
  if (existsSync(outPath) && statSync(outPath).size > 0) {
    return { ok: true, path: outPath, cached: true }
  }

  // 固定的 python 端脚本（纯 ASCII，避免命令行编码问题）。
  const script = [
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
