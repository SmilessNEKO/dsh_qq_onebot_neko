// voice.js 单测：切块 / 缓存名 / record 段 / 合成失败路径 / 两套语音引擎（edge / feiyu）。纯离线，零依赖。
// 运行：node test-voice.mjs
// edge 合成部分只在 DSH_TTS_TEST_PYTHON 指向装了 edge-tts 的解释器时才真跑，
// 否则只验「解释器不存在时优雅失败」「模型目录不存在时直接失败」。
// 肥鱼引擎用 Node 内置 http 起**假服务**真跑 HTTP 全流程（不依赖真肥鱼服务在不在）：
// 成功 / 任务失败 / 鉴权不过 / 连不上 / 超时 / 缓存命中不重复请求 / 带没带鉴权头。
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_FFMPEG_TIMEOUT_MS,
  DEFAULT_FEIYU_BASE_URL,
  DEFAULT_FEIYU_POLL_INTERVAL_MS,
  DEFAULT_FEIYU_SING_TIMEOUT_MS,
  DEFAULT_FEIYU_STYLE,
  DEFAULT_FEIYU_TIMEOUT_MS,
  DEFAULT_FEIYU_VOICE,
  DEFAULT_TTS_PITCH,
  DEFAULT_TTS_RATE,
  DEFAULT_TTS_VOICE,
  DEFAULT_VOICE_MAX_SONG_CHARS,
  DEFAULT_VOICE_PROVIDER,
  DEFAULT_FEIYU_IDLE_STOP_MINUTES,
  DEFAULT_FEIYU_PROBE_TIMEOUT_MS,
  DEFAULT_FEIYU_START_TIMEOUT_MS,
  ensureFeiyuService,
  ensureRecordAudio,
  feiyuSing,
  feiyuSynthesize,
  hasVoiceBlock,
  normalizeFeiyuStyle,
  normalizeVoiceProvider,
  noteFeiyuActivity,
  probeFeiyuService,
  resetFeiyuServices,
  stopFeiyuService,
  recordSegment,
  splitVoiceBlocks,
  stripVoiceBlocks,
  synthesize,
  voiceCacheName,
  VOICE_FILTER_CHAIN,
  VOICE_TONE_PRESETS,
  DEFAULT_VOICE_TONE,
  DEFAULT_VOICE_PITCH_SEMITONES,
  DEFAULT_VOICE_SPEED_FACTOR,
  buildVoiceFilterChain,
  normalizeVoiceTone,
  normalizeVoiceMood,
  voiceMoodPreset,
  VOICE_MOOD_PRESETS,
  DEFAULT_VOICE_MOOD,
  VOICE_OUTPUT_BITRATE,
  VOICE_OUTPUT_SAMPLE_RATE,
  VOICE_PROVIDERS,
} from './voice.js'

let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}

// 1) 切块：纯文字 → 单 text 段
{
  const pieces = splitVoiceBlocks('在的呀~')
  check('纯文字只有一个 text 段', pieces.length === 1 && pieces[0].type === 'text' && pieces[0].text === '在的呀~')
}

// 2) 切块：文字 + 语音 + 文字 的顺序与内容
{
  const pieces = splitVoiceBlocks('先说一句\n[语音]然后这句用语音[/语音]\n再说一句')
  check('三段的类型顺序', pieces.map((p) => p.type).join(',') === 'text,voice,text')
  check('语音段剥掉了标记', pieces[1].text === '然后这句用语音')
  check('文字段保留原文（带换行）', pieces[0].text.includes('先说一句') && pieces[2].text.includes('再说一句'))
}

// 3) 切块：语音在开头 / 结尾
{
  const a = splitVoiceBlocks('[语音]开头就是语音[/语音]后面是字')
  check('语音在开头 → voice,text', a.map((p) => p.type).join(',') === 'voice,text')
  const b = splitVoiceBlocks('前面是字[语音]结尾是语音[/语音]')
  check('语音在结尾 → text,voice', b.map((p) => p.type).join(',') === 'text,voice')
}

// 4) 切块：连续两条语音、中间夹空白
{
  const pieces = splitVoiceBlocks('[语音]第一句[/语音]\n\n[语音]第二句[/语音]')
  check('两条语音不产生空 text 段', pieces.map((p) => p.type).join(',') === 'voice,voice')
  check('两条语音内容分别正确', pieces[0].text === '第一句' && pieces[1].text === '第二句')
}

// 5) 切块：空块、只有空白的块要被丢掉
{
  check('空语音标记不产生段', splitVoiceBlocks('[语音][/语音]').length === 0)
  check('空白语音标记不产生段', splitVoiceBlocks('[语音]   [/语音]').length === 0)
  check('空正文返回空数组', splitVoiceBlocks('').length === 0)
  check('null 不会抛', splitVoiceBlocks(null).length === 0)
}

// 6) 多行语音块
{
  const pieces = splitVoiceBlocks('[语音]第一行\n第二行[/语音]')
  check('跨行语音块被切开并保留换行', pieces.length === 1 && pieces[0].text === '第一行\n第二行')
}

// 7) hasVoiceBlock / stripVoiceBlocks
{
  check('hasVoiceBlock 认得标记', hasVoiceBlock('a[语音]b[/语音]c') === true)
  check('hasVoiceBlock 没标记时为 false', hasVoiceBlock('普通一句话') === false)
  check('stripVoiceBlocks 去掉标记留文字', stripVoiceBlocks('前[语音]不算[/语音]后').replace(/\s+/g, '') === '前后')
  check('stripVoiceBlocks 没有标记时原样', stripVoiceBlocks('没有标记').trim() === '没有标记')
}

// 8) 缓存名：同样输入恒定、不同参数不同名、16 位十六进制
{
  const opts = { voice: 'v1', rate: '-8%', pitch: '+12Hz' }
  const n1 = voiceCacheName('同一句话', opts)
  const n2 = voiceCacheName('同一句话', { ...opts })
  check('同输入 → 同缓存名', n1 === n2)
  check('缓存名是 16 位十六进制 .mp3', /^[0-9a-f]{16}\.mp3$/.test(n1), n1)
  check('换文本 → 换名字', voiceCacheName('另一句话', opts) !== n1)
  check('换音色 → 换名字', voiceCacheName('同一句话', { ...opts, voice: 'v2' }) !== n1)
  check('换语速 → 换名字', voiceCacheName('同一句话', { ...opts, rate: '+0%' }) !== n1)
  check('换音高 → 换名字', voiceCacheName('同一句话', { ...opts, pitch: '+0Hz' }) !== n1)
}

// 9) recordSegment：Windows 反斜杠转成正斜杠 + file:// 前缀
{
  const seg = recordSegment('D:\\DSH_QQBOT\\a.mp3')
  check('record 段类型是 record', seg.type === 'record')
  check('路径转成正斜杠并加 file://', seg.data.file === 'file:///D:/DSH_QQBOT/a.mp3', seg.data.file)
  const posix = recordSegment('/home/u/a.mp3')
  check('已经是 posix 路径时不重复加斜杠', posix.data.file === 'file:///home/u/a.mp3', posix.data.file)
}

// 10) 默认值
{
  check('默认音色是中文少女音', DEFAULT_TTS_VOICE === 'zh-CN-XiaoyiNeural')
  check('默认语速 -8%', DEFAULT_TTS_RATE === '-8%')
  check('默认音高 +12Hz', DEFAULT_TTS_PITCH === '+12Hz')
}

const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-neko-voice-'))

// 11) 合成：空文本直接失败，不起进程
{
  const r = await synthesize('   ', { cacheDir: dir })
  check('空文本 → empty-text', r.ok === false && r.reason === 'empty-text')
}

// 12) 合成：没给 cacheDir 直接失败
{
  const r = await synthesize('一句话', { cacheDir: '' })
  check('没有缓存目录 → no-cache-dir', r.ok === false && r.reason === 'no-cache-dir')
}

// 13) 合成：解释器不存在时优雅失败（不抛、不卡死）
{
  const r = await synthesize('一句话', {
    cacheDir: dir,
    pythonPath: join(dir, 'definitely-not-a-python.exe'),
    timeoutMs: 8000,
  })
  check('解释器不存在 → 失败但不抛', r.ok === false && typeof r.reason === 'string', r.reason)
}

// 14) 合成：真跑一段（只在给了测试解释器时）
{
  const py = process.env.DSH_TTS_TEST_PYTHON
  if (!py) {
    console.log('SKIP  真跑合成（没设 DSH_TTS_TEST_PYTHON）')
  } else {
    const r1 = await synthesize('这是一条测试语音。', { cacheDir: dir, pythonPath: py, timeoutMs: 30000 })
    check('真跑合成成功', r1.ok === true, r1.ok ? r1.path : r1.reason)
    if (r1.ok) {
      check('产物文件存在且有内容', existsSync(r1.path) && statSync(r1.path).size > 0)
      check('第一次是现合成（cached=false）', r1.cached === false)
      const r2 = await synthesize('这是一条测试语音。', { cacheDir: dir, pythonPath: py, timeoutMs: 30000 })
      check('第二次命中缓存（cached=true）', r2.ok === true && r2.cached === true)
    }
  }
}

// 15) 缓存名：引擎进哈希，edge / feiyu 两家互不撞
{
  const names = voiceCacheName('同一句话', { provider: 'feiyu', voice: 'feiyu', style: 'cute' })
  check('肥鱼产物是 16 位十六进制 .wav', /^[0-9a-f]{16}\.wav$/.test(names), names)
  check('同输入 → 同缓存名（肥鱼）', names === voiceCacheName('同一句话', { provider: 'feiyu', voice: 'feiyu', style: 'cute' }))
  check('换语气 → 换名字', voiceCacheName('同一句话', { provider: 'feiyu', voice: 'feiyu', style: 'gentle' }) !== names)
  check('换音色 → 换名字', voiceCacheName('同一句话', { provider: 'feiyu', voice: 'other', style: 'cute' }) !== names)
  check('认不出的语气回落 cute（名字不变）', voiceCacheName('同一句话', { provider: 'feiyu', voice: 'feiyu', style: '乱写' }) === names)
  const edge = voiceCacheName('同一句话', { provider: 'edge', voice: 'feiyu', style: 'cute', rate: '-8%', pitch: '+12Hz' })
  check('edge 产物是 .mp3', /^[0-9a-f]{16}\.mp3$/.test(edge), edge)
  check(
    '两家同名不同产物（哈希互不相同）',
    new Set([edge.slice(0, 16), names.slice(0, 16)]).size === 2,
    `${edge} / ${names}`,
  )
  check('认不出的引擎回落 edge（.mp3）', voiceCacheName('同一句话', { provider: 'nope' }).endsWith('.mp3'))
  check('ext 可以覆盖后缀', voiceCacheName('同一句话', { provider: 'feiyu', ext: 'mp3' }).endsWith('.mp3'))
}

// 16) 默认值：默认引擎必须是 edge（升级后行为不变）
{
  check('默认引擎是 edge', DEFAULT_VOICE_PROVIDER === 'edge')
  check('两个引擎都在名单里', VOICE_PROVIDERS.join(',') === 'edge,feiyu', VOICE_PROVIDERS.join(','))
  check(
    'normalizeVoiceProvider 认 feiyu（大小写无所谓）',
    normalizeVoiceProvider('FEIYU') === 'feiyu' && normalizeVoiceProvider('Edge') === 'edge',
  )
  check('sherpa 已经摘掉：写 sherpa 会回落 edge', normalizeVoiceProvider('sherpa') === 'edge')
  check('normalizeVoiceProvider 认不出就回落 edge', normalizeVoiceProvider('whatever') === 'edge' && normalizeVoiceProvider(undefined) === 'edge')
  check('normalizeFeiyuStyle 认 gentle', normalizeFeiyuStyle('Gentle') === 'gentle')
  check('normalizeFeiyuStyle 认不出回落 cute', normalizeFeiyuStyle('') === 'cute')
  check('默认地址是本机 9880', DEFAULT_FEIYU_BASE_URL === 'http://127.0.0.1:9880')
  check('默认等 180 秒（首次加载模型要慢）', DEFAULT_FEIYU_TIMEOUT_MS === 180000)
  check('默认每秒问一次', DEFAULT_FEIYU_POLL_INTERVAL_MS === 1000)
  check('转码最多 30 秒', DEFAULT_FFMPEG_TIMEOUT_MS === 30000)
  check('默认语气 cute、默认音色 feiyu', DEFAULT_FEIYU_STYLE === 'cute' && DEFAULT_FEIYU_VOICE === 'feiyu')
  check('唱歌默认等 10 分钟（SVS + RVC + 混音慢一个量级）', DEFAULT_FEIYU_SING_TIMEOUT_MS === 600000)
  check('一首歌默认最多 400 个唱字', DEFAULT_VOICE_MAX_SONG_CHARS === 400)
}

// ── 假肥鱼服务：用 Node 内置 http 起一个真服务，测完整 HTTP 路径 ──────────────
const WAV_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32, 7)])

/** 起一个假服务；handler(entry, res, state) 决定怎么答。用 0 端口，不占固定端口。 */
function startFeiyu(handler) {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body }
      requests.push(entry)
      // /health 由这里统一应答：真实服务上它免鉴权、永远 200。合成前插件会先探它，
      // 探不到就会去自动拉起服务，测试里没必要掺这一层。
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', version: 'test' }))
        return
      }
      try {
        handler(entry, res, requests)
      } catch (error) {
        res.statusCode = 500
        res.end(String(error?.message ?? error))
      }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

/** 一个「正常」的假服务：提交 → running → success → 给 WAV。 */
function happyHandler(entry, res, requests) {
  if (entry.method === 'POST' && entry.url === '/v1/speech') {
    res.writeHead(202, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ job_id: 'J-OK' }))
    return
  }
  if (entry.url === '/v1/jobs/J-OK') {
    // 第一次轮询 running、第二次才 success —— 顺便验证真的会等
    const seen = requests.filter((r) => r.url === '/v1/jobs/J-OK').length
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: seen < 2 ? 'running' : 'success' }))
    return
  }
  if (entry.url === '/v1/jobs/J-OK/audio') {
    res.writeHead(200, { 'content-type': 'audio/wav' })
    res.end(WAV_BYTES)
    return
  }
  res.statusCode = 404
  res.end('{}')
}

// 17) 参数校验：不起请求就该失败
{
  const r1 = await feiyuSynthesize('   ', { cacheDir: dir, baseUrl: 'http://127.0.0.1:1' })
  check('空文本 → empty-text', r1.ok === false && r1.reason === 'empty-text')
  const r2 = await feiyuSynthesize('一句话', { cacheDir: '', baseUrl: 'http://127.0.0.1:1' })
  check('没有缓存目录 → no-cache-dir', r2.ok === false && r2.reason === 'no-cache-dir')
  const r3 = await feiyuSynthesize('一句话', { cacheDir: dir, baseUrl: 'ftp://x' })
  check('认不出的协议 → bad-base-url', r3.ok === false && r3.reason.startsWith('bad-base-url'), r3.reason)
  const r4 = await feiyuSynthesize('一句话', { cacheDir: dir, baseUrl: '不是个地址' })
  check('地址不是 URL → bad-base-url', r4.ok === false && r4.reason.startsWith('bad-base-url'), r4.reason)
}

// 18) 成功路径：POST → 轮询 → 下 WAV，落盘 + 鉴权头 + 请求体
{
  const svc = await startFeiyu(happyHandler)
  const text = '肥鱼测试第一句'
  const r = await feiyuSynthesize(text, {
    cacheDir: dir,
    baseUrl: svc.baseUrl,
    apiKey: 'test-key',
    voice: 'feiyu',
    style: 'gentle',
    timeoutMs: 8000,
    pollIntervalMs: 20,
  })
  check('肥鱼合成成功', r.ok === true, r.ok ? r.path : r.reason)
  if (r.ok) {
    check('产物文件存在且有内容', existsSync(r.path) && statSync(r.path).size === WAV_BYTES.length, String(statSync(r.path).size))
    check('产物是 .wav', r.path.endsWith('.wav'), r.path)
    check('第一次是现合成（cached=false）', r.cached === false)
  }
  const post = svc.requests.find((q) => q.method === 'POST' && q.url === '/v1/speech')
  check('合成前先探过 /health', svc.requests.some((q) => q.url === '/health'))
  check('提交任务是 POST /v1/speech', post?.method === 'POST' && post?.url === '/v1/speech', `${post?.method} ${post?.url}`)
  check('带 Bearer 鉴权头', post?.headers?.authorization === 'Bearer test-key')
  const sent = JSON.parse(post?.body ?? '{}')
  check('请求体带 voice/text/style', sent.voice === 'feiyu' && sent.text === text && sent.style === 'gentle', post?.body)
  check('轮询请求走 GET /v1/jobs/J-OK', svc.requests.some((q) => q.method === 'GET' && q.url === '/v1/jobs/J-OK'))
  check('最后下音频 /v1/jobs/J-OK/audio', svc.requests.at(-1)?.url === '/v1/jobs/J-OK/audio', svc.requests.at(-1)?.url)
  check('轮询超过一次（真的等了 running）', svc.requests.filter((q) => q.url === '/v1/jobs/J-OK').length >= 2)
  check('失败原因里没有 API key', !JSON.stringify(r).includes('test-key'))
  await svc.close()
}

// 19) 任务失败：status=failed → job-failed + 对端给的原因
{
  const svc = await startFeiyu((entry, res) => {
    if (entry.method === 'POST') {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'J-BAD' }))
      return
    }
    if (entry.url === '/v1/jobs/J-BAD') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'failed', error: '模型没加载' }))
      return
    }
    res.statusCode = 500
    res.end('x')
  })
  const r = await feiyuSynthesize('任务失败这句', {
    cacheDir: dir, baseUrl: svc.baseUrl, timeoutMs: 5000, pollIntervalMs: 20,
  })
  check('任务 failed → job-failed', r.ok === false && r.reason === 'job-failed: 模型没加载', r.reason)
  check('失败时不请求音频接口', !svc.requests.some((q) => q.url.endsWith('/audio')))
  await svc.close()
}

// 20) 任务被打断 / 鉴权不过 / 非 2xx
{
  const svc = await startFeiyu((entry, res) => {
    if (entry.method === 'POST') { res.writeHead(202, { 'content-type': 'application/json' }); res.end('{"id":"J-I"}'); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"status":"interrupted"}')
  })
  const r = await feiyuSynthesize('被打断这句', { cacheDir: dir, baseUrl: svc.baseUrl, timeoutMs: 5000, pollIntervalMs: 20 })
  check('任务 interrupted → job-interrupted', r.ok === false && r.reason === 'job-interrupted', r.reason)
  await svc.close()

  const auth = await startFeiyu((entry, res) => { res.writeHead(401); res.end('nope') })
  const ra = await feiyuSynthesize('鉴权不过这句', { cacheDir: dir, baseUrl: auth.baseUrl, apiKey: 'wrong', timeoutMs: 5000 })
  check('401 → auth-failed: 401', ra.ok === false && ra.reason === 'auth-failed: 401', ra.reason)
  await auth.close()

  const boom = await startFeiyu((entry, res) => { res.writeHead(500); res.end('{}') })
  const rb = await feiyuSynthesize('服务报错这句', { cacheDir: dir, baseUrl: boom.baseUrl, timeoutMs: 5000 })
  check('500 → speech-http-500', rb.ok === false && rb.reason === 'speech-http-500', rb.reason)
  await boom.close()

  const noId = await startFeiyu((entry, res) => { res.writeHead(202, { 'content-type': 'application/json' }); res.end('{}') })
  const rn = await feiyuSynthesize('没任务号这句', { cacheDir: dir, baseUrl: noId.baseUrl, timeoutMs: 5000 })
  check('202 但没任务号 → no-job-id', rn.ok === false && rn.reason === 'no-job-id', rn.reason)
  await noId.close()
}

// 21) 连不上：地址没人听，失败但不抛
{
  const dead = await startFeiyu((entry, res) => { res.end('') })
  const deadUrl = dead.baseUrl
  await dead.close()   // 端口关掉了，连它必失败
  // 关掉自动启动：探活失败就该直接失败，而不是去拉一个不存在的服务。
  const r = await feiyuSynthesize('连不上这句', {
    cacheDir: dir, baseUrl: deadUrl, timeoutMs: 5000, pollIntervalMs: 20, autoStart: false,
  })
  check('连不上 + 不开自动启动 → service-down（不抛）', r.ok === false && r.reason.startsWith('service-down'), r.reason)
  // 服务起着、但 POST 时连接被掐：这才是 connect-failed。
  const flaky = await startFeiyu((entry, res, requests) => {
    res.destroy()
  })
  const rf = await feiyuSynthesize('半路断开这句', { cacheDir: dir, baseUrl: flaky.baseUrl, timeoutMs: 3000, pollIntervalMs: 20 })
  check('连接被掐 → connect-failed（不抛）', rf.ok === false && rf.reason.startsWith('connect-failed'), rf.reason)
  await flaky.close()
}

// 22) 超时：任务永远 running，到点必须放弃
{
  const svc = await startFeiyu((entry, res) => {
    if (entry.method === 'POST') { res.writeHead(202, { 'content-type': 'application/json' }); res.end('{"id":"J-SLOW"}'); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"status":"running"}')
  })
  const r = await feiyuSynthesize('超时这句', { cacheDir: dir, baseUrl: svc.baseUrl, timeoutMs: 200, pollIntervalMs: 30 })
  check('一直 running → timeout: 200ms', r.ok === false && r.reason === 'timeout: 200ms', r.reason)
  await svc.close()
}

// 23) 缓存命中：同一句话第二次不再打任何请求
{
  const first = await startFeiyu(happyHandler)
  const text = '缓存命中这句'
  const r1 = await feiyuSynthesize(text, { cacheDir: dir, baseUrl: first.baseUrl, timeoutMs: 8000, pollIntervalMs: 20 })
  check('首次合成成功', r1.ok === true, r1.ok ? r1.path : r1.reason)
  const used = first.requests.length
  await first.close()

  // 换一个「怎么问都 500」的服务：真去打请求就必然失败，命中缓存才不会失败。
  const poisoned = await startFeiyu((entry, res) => { res.writeHead(500); res.end('{}') })
  const r2 = await feiyuSynthesize(text, { cacheDir: dir, baseUrl: poisoned.baseUrl, timeoutMs: 3000, pollIntervalMs: 20 })
  check('第二次命中缓存（cached=true）', r2.ok === true && r2.cached === true, r2.ok ? String(r2.cached) : r2.reason)
  check('命中缓存时一个请求都没发', poisoned.requests.length === 0, String(poisoned.requests.length))
  check('首次真的发过请求', used > 0, String(used))
  await poisoned.close()
}

// 24) 统一入口 synthesize 的分派：三个引擎各走各的，谁也不冒充谁
{
  const feiyu = await synthesize('分派测试', { provider: 'feiyu', cacheDir: dir, baseUrl: 'ftp://x' })
  check('provider=feiyu 走肥鱼实现', feiyu.ok === false && feiyu.reason.startsWith('bad-base-url'), feiyu.reason)
  const sherpa = await synthesize('分派测试', { provider: 'sherpa', cacheDir: dir, pythonPath: join(dir, 'definitely-not-a-python.exe'), timeoutMs: 8000 })
  check('provider=sherpa 已摘掉：回落到 edge（不是报 sherpa 专属错）', sherpa.ok === false && !String(sherpa.reason).startsWith('sherpa'), sherpa.reason)
  const bogus = await synthesize('分派测试', { provider: 'nope', cacheDir: dir })
  check('认不出的引擎直接失败（不悄悄换实现）', bogus.ok === false && bogus.reason === 'unsupported-tts-provider: nope', bogus.reason)
  const edge = await synthesize('分派测试', {
    provider: 'edge', cacheDir: dir, pythonPath: join(dir, 'definitely-not-a-python.exe'), timeoutMs: 8000,
  })
  check('provider=edge 走 edge 实现（解释器不存在时优雅失败）', edge.ok === false && typeof edge.reason === 'string', edge.reason)
  const dflt = await synthesize('   ', { cacheDir: dir })
  check('不传引擎当 edge（空文本 → empty-text）', dflt.ok === false && dflt.reason === 'empty-text')
}

// 24b) 不带口令时不应该发出鉴权头
{
  const svc = await startFeiyu(happyHandler)
  const r = await feiyuSynthesize('没口令这句', { cacheDir: dir, baseUrl: svc.baseUrl, timeoutMs: 8000, pollIntervalMs: 20 })
  check('不给口令也能合成', r.ok === true, r.ok ? r.path : r.reason)
  check('没口令 → 一个鉴权头都不带', svc.requests.every((q) => q.headers.authorization === undefined), JSON.stringify(svc.requests[0]?.headers ?? {}))
  await svc.close()
}

// 25) ensureRecordAudio：只有 wav 才转，失败一律回落原文件
{
  const plain = join(dir, 'plain.mp3')
  writeFileSync(plain, 'x')
  const e1 = await ensureRecordAudio(plain)
  check('非 wav 原样返回', e1.path === plain && e1.converted === false)

  const e2 = await ensureRecordAudio('')
  check('空路径 → empty-path', e2.path === '' && e2.reason === 'empty-path')

  const wav = join(dir, 'need-convert.wav')
  writeFileSync(wav, WAV_BYTES)
  const e3 = await ensureRecordAudio(wav, { ffmpegPath: join(dir, 'no-such-ffmpeg.exe'), timeoutMs: 5000 })
  check('没 ffmpeg 时回落原 wav（不抛、不算失败）', e3.path === wav && e3.converted === false && typeof e3.reason === 'string', e3.reason)
  check('回落原因带前缀', /^ffmpeg-(missing|spawn-failed|exit)/.test(e3.reason), e3.reason)

  const cachedMp3 = join(dir, 'already-done.wav')
  writeFileSync(cachedMp3, WAV_BYTES)
  writeFileSync(join(dir, 'already-done.mp3'), 'mp3-bytes')
  const e4 = await ensureRecordAudio(cachedMp3)
  check('已有同名 mp3 时直接用（converted=true）', e4.path === join(dir, 'already-done.mp3') && e4.converted === true)

  const seg = recordSegment(wav)
  check('wav 路径也能进 record 段', seg.type === 'record' && seg.data.file.startsWith('file:///'))
}

// 26) ensureRecordAudio：真装 ffmpeg 的机器上，wav → mp3 真转一次
{
  // 造一段真的 8kHz 单声道 PCM WAV（不是上面那种假字节，ffmpeg 解得开）
  const frames = 1600
  const pcm = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * 3000), i * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(16000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  const realWav = join(dir, 'real-tone.wav')
  writeFileSync(realWav, Buffer.concat([header, pcm]))

  const r = await ensureRecordAudio(realWav, { timeoutMs: 20000 })
  if (r.converted === true) {
    check('装了 ffmpeg：wav 真转出 mp3', existsSync(r.path) && statSync(r.path).size > 0, `${r.path} ${statSync(r.path).size}B`)
    check('转码产物后缀是 .mp3', r.path.endsWith('.mp3'), r.path)
    const again = await ensureRecordAudio(realWav, { timeoutMs: 20000 })
    check('再转一次直接用已有 mp3（不重复转码）', again.converted === true && again.path === r.path)
  } else if (/^ffmpeg-(missing|spawn-failed)/.test(String(r.reason))) {
    console.log(`SKIP  真转码（本机没装 ffmpeg：${r.reason}）`)
  } else {
    check('装了 ffmpeg：wav 真转出 mp3', false, r.reason)
  }
}

// ── 唱歌（feiyuSing）：谱 + 歌词 → 假服务走完整 HTTP 路径 ───────────────────
const ABC = 'X:1\nT:t\nM:4/4\nL:1/4\nK:C\nC D E F|G4|'
const LYRICS = '一二三四五六'

function singHandler(entry, res, requests) {
  if (entry.method === 'POST' && entry.url === '/v1/assets') {
    const n = requests.filter((r) => r.url === '/v1/assets').length
    res.writeHead(201, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: `A-${n}` }))
    return
  }
  if (entry.method === 'POST' && entry.url === '/v1/singing') {
    res.writeHead(202, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ job_id: 'J-SING' }))
    return
  }
  if (entry.url === '/v1/jobs/J-SING') {
    const seen = requests.filter((r) => r.url === '/v1/jobs/J-SING').length
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(seen < 2
      ? { status: 'running' }
      : { status: 'success', audio: { seconds: 12.5 } }))
    return
  }
  if (entry.url === '/v1/jobs/J-SING/audio') {
    res.writeHead(200, { 'content-type': 'audio/wav' })
    res.end(WAV_BYTES)
    return
  }
  res.statusCode = 404
  res.end('{}')
}

// 27) feiyuSing 参数校验：不起请求就该失败
{
  const r1 = await feiyuSing({ score: '  ', lyrics: LYRICS, cacheDir: dir, baseUrl: 'http://127.0.0.1:1' })
  check('空谱子 → empty-score', r1.ok === false && r1.reason === 'empty-score', r1.reason)
  const r2 = await feiyuSing({ score: ABC, lyrics: '  ', cacheDir: dir, baseUrl: 'http://127.0.0.1:1' })
  check('空歌词 → no-lyrics', r2.ok === false && r2.reason === 'no-lyrics', r2.reason)
  const r3 = await feiyuSing({ score: ABC, lyrics: LYRICS, cacheDir: '', baseUrl: 'http://127.0.0.1:1' })
  check('没有缓存目录 → no-cache-dir', r3.ok === false && r3.reason === 'no-cache-dir', r3.reason)
  const r4 = await feiyuSing({ score: ABC, lyrics: LYRICS, cacheDir: dir, baseUrl: 'ftp://x' })
  check('认不出的协议 → bad-base-url', r4.ok === false && r4.reason.startsWith('bad-base-url'), r4.reason)
}

// 28) 成功路径：两次上传 → /v1/singing → 轮询 → 下 WAV
{
  const svc = await startFeiyu(singHandler)
  const r = await feiyuSing({
    score: ABC, lyrics: LYRICS, cacheDir: dir, baseUrl: svc.baseUrl,
    apiKey: 'sing-key', voice: 'feiyu', timeoutMs: 8000, pollIntervalMs: 20,
  })
  check('唱歌成功', r.ok === true, r.ok ? r.path : r.reason)
  if (r.ok) {
    check('产物文件存在且有内容', existsSync(r.path) && statSync(r.path).size > 0, String(statSync(r.path).size))
    check('回传了 audio.seconds', r.seconds === 12.5, String(r.seconds))
    check('第一次是现合成（cached=false）', r.cached === false)
  }
  const uploads = svc.requests.filter((q) => q.method === 'POST' && q.url === '/v1/assets')
  check('谱子和歌词各传一次（共 2 次 /v1/assets）', uploads.length === 2, String(uploads.length))
  const post = svc.requests.find((q) => q.url === '/v1/singing')
  check('提交到 POST /v1/singing', post?.method === 'POST')
  check('唱歌也带 Bearer 鉴权头', post?.headers?.authorization === 'Bearer sing-key')
  const sent = JSON.parse(post?.body ?? '{}')
  check('提交体带 voice/score_id/lyrics_id', sent.voice === 'feiyu' && sent.score_id === 'A-1' && sent.lyrics_id === 'A-2', post?.body)
  check('没传 transpose 时不塞这个字段', sent.transpose === undefined && sent.bpm === undefined, post?.body)
  check('轮询超过一次（真的等了 running）', svc.requests.filter((q) => q.url === '/v1/jobs/J-SING').length >= 2)
  check('最后下音频 /v1/jobs/J-SING/audio', svc.requests.at(-1)?.url === '/v1/jobs/J-SING/audio', svc.requests.at(-1)?.url)
  check('失败原因里没有 API key', !JSON.stringify(r).includes('sing-key'))
  await svc.close()
}

// 29) 带拼音 → 传三次资源，提交体里多一个 pinyin_id
{
  const svc = await startFeiyu(singHandler)
  const r = await feiyuSing({
    score: ABC, lyrics: LYRICS, pinyin: 'yi1 er4 san1 si4', cacheDir: dir, baseUrl: svc.baseUrl,
    timeoutMs: 8000, pollIntervalMs: 20,
  })
  check('带拼音也能唱', r.ok === true, r.ok ? r.path : r.reason)
  check('三份资源（谱/词/拼音）各传一次', svc.requests.filter((q) => q.url === '/v1/assets').length === 3)
  const sent = JSON.parse(svc.requests.find((q) => q.url === '/v1/singing')?.body ?? '{}')
  check('提交体带 pinyin_id', sent.pinyin_id === 'A-3', JSON.stringify(sent))
  await svc.close()
}

// 30) transpose / bpm 只在给了正数时才写进提交体
//     注意：每个用例用不同歌词，否则会命中上一用例的缓存、根本不发请求。
{
  const svc = await startFeiyu(singHandler)
  await feiyuSing({
    score: ABC, lyrics: '移调速度测试', cacheDir: dir, baseUrl: svc.baseUrl,
    transpose: -3, bpm: 96, timeoutMs: 8000, pollIntervalMs: 20,
  })
  const sent = JSON.parse(svc.requests.find((q) => q.url === '/v1/singing')?.body ?? '{}')
  check('transpose 写进提交体', sent.transpose === -3, JSON.stringify(sent))
  check('bpm 写进提交体', sent.bpm === 96, JSON.stringify(sent))
  await svc.close()
}

// 31) 任务失败 → job-failed + 对端给的原因
{
  const svc = await startFeiyu((entry, res) => {
    if (entry.method === 'POST' && entry.url === '/v1/assets') {
      res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"id":"A-x"}'); return
    }
    if (entry.method === 'POST') { res.writeHead(202, { 'content-type': 'application/json' }); res.end('{"id":"J-BAD"}'); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"status":"failed","error":"谱面解析不出来"}')
  })
  const r = await feiyuSing({ score: ABC, lyrics: '任务失败歌词', cacheDir: dir, baseUrl: svc.baseUrl, timeoutMs: 5000, pollIntervalMs: 20 })
  check('唱歌任务失败 → job-failed 带原因', r.ok === false && r.reason === 'job-failed: 谱面解析不出来', r.reason)
  await svc.close()
}

// 32) 鉴权不过 → auth-failed: 401（区分于普通 http 错误）
{
  const svc = await startFeiyu((entry, res) => { res.writeHead(401); res.end('{}') })
  const r = await feiyuSing({ score: ABC, lyrics: '鉴权失败歌词', cacheDir: dir, baseUrl: svc.baseUrl, timeoutMs: 5000, pollIntervalMs: 20 })
  check('401 → auth-failed: 401', r.ok === false && r.reason === 'auth-failed: 401', r.reason)
  await svc.close()
}

// 33) 超时：一直 running，到点必须放弃（唱歌给的时间比说话长得多）
{
  const svc = await startFeiyu((entry, res) => {
    if (entry.method === 'POST' && entry.url === '/v1/assets') {
      res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"id":"A-y"}'); return
    }
    if (entry.method === 'POST') { res.writeHead(202, { 'content-type': 'application/json' }); res.end('{"id":"J-SLOW"}'); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"running"}')
  })
  const r = await feiyuSing({ score: ABC, lyrics: '超时歌词', cacheDir: dir, baseUrl: svc.baseUrl, timeoutMs: 250, pollIntervalMs: 30 })
  check('唱歌一直 running → timeout: 250ms', r.ok === false && r.reason === 'timeout: 250ms', r.reason)
  await svc.close()
}

// 34) 缓存命中：同一份谱 + 同一份词，第二次一个请求都不发
{
  const first = await startFeiyu(singHandler)
  const opts = { score: ABC, lyrics: '缓存测试词', cacheDir: dir, baseUrl: first.baseUrl, timeoutMs: 8000, pollIntervalMs: 20 }
  const r1 = await feiyuSing(opts)
  check('唱歌首次成功', r1.ok === true, r1.ok ? r1.path : r1.reason)
  await first.close()
  const poisoned = await startFeiyu((entry, res) => { res.writeHead(500); res.end('{}') })
  const r2 = await feiyuSing({ ...opts, baseUrl: poisoned.baseUrl })
  check('唱歌第二次命中缓存（cached=true）', r2.ok === true && r2.cached === true, r2.ok ? String(r2.cached) : r2.reason)
  check('命中缓存时一个请求都没发', poisoned.requests.length === 0, String(poisoned.requests.length))
  await poisoned.close()
  // 换一句词就是另一首歌，不会误命中
  const third = await startFeiyu(singHandler)
  const r3 = await feiyuSing({ ...opts, lyrics: '换一句词', baseUrl: third.baseUrl })
  check('换歌词 → 不命中旧缓存，真去请求', r3.ok === true && r3.cached === false && third.requests.length > 0)
  await third.close()
}

// ── 自动启停：探活 / 拉起 / 去重 / 空闲自停 ────────────────────────────────
// 全程用假的 fetch + 假的 spawn，不碰真服务、不占端口、不真起进程。

/** 一个可编程的假环境：health 通不通、被 spawn 几次、shutdown 被调几次。 */
function fakeWorld() {
  const state = { up: false, spawns: [], shutdownCalls: 0, killed: 0 }
  const fetchImpl = async (target) => {
    const u = String(target)
    if (u.endsWith('/health')) {
      if (!state.up) {
        const error = new Error('fetch failed')
        error.cause = { code: 'ECONNREFUSED' }
        throw error
      }
      return new Response(JSON.stringify({ status: 'ok', version: 'stub' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (u.endsWith('/v1/admin/shutdown')) {
      state.shutdownCalls += 1
      state.up = false
      return new Response(JSON.stringify({ status: 'shutting-down' }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  const spawnImpl = (spec) => {
    state.spawns.push(spec)
    state.up = true
    return { unref() {}, exitCode: null, signalCode: null, kill() { state.killed += 1; state.up = false } }
  }
  return { state, fetchImpl, spawnImpl }
}

// 35) 常量：滤镜链与输出规格
{
  check('滤镜链带高通/低通/两段 EQ/压缩/响度', ['highpass', 'lowpass', 'equalizer', 'acompressor', 'loudnorm']
    .every((x) => VOICE_FILTER_CHAIN.includes(x)), VOICE_FILTER_CHAIN)
  check('输出 44.1kHz（loudnorm 会升到 192k，必须显式收回来）', VOICE_OUTPUT_SAMPLE_RATE === 44100)
  check('码率 96k', VOICE_OUTPUT_BITRATE === '96k')
  check('空闲默认 10 分钟', DEFAULT_FEIYU_IDLE_STOP_MINUTES === 10)
  check('启动等 60 秒、探活 3 秒', DEFAULT_FEIYU_START_TIMEOUT_MS === 60000 && DEFAULT_FEIYU_PROBE_TIMEOUT_MS === 3000)
}

// 36) 探活：通 → ok + version；不通 → service-down 带错误码
{
  const ok = fakeWorld()
  ok.state.up = true
  const a = await probeFeiyuService({ baseUrl: 'http://127.0.0.1:19001', fetchImpl: ok.fetchImpl })
  check('探活通 → ok 带 version', a.ok === true && a.version === 'stub', JSON.stringify(a))

  const down = fakeWorld()
  const b = await probeFeiyuService({ baseUrl: 'http://127.0.0.1:19002', fetchImpl: down.fetchImpl })
  check('探活不通 → service-down 带错误码', b.ok === false && b.reason.startsWith('service-down: ECONNREFUSED'), b.reason)

  const bad = await probeFeiyuService({ baseUrl: 'ftp://x', fetchImpl: down.fetchImpl })
  check('探活地址非法 → bad-base-url', bad.ok === false && bad.reason.startsWith('bad-base-url'), bad.reason)
}

// 37) 服务没起 → 自动拉起（argv 走 python -m feiyu_voice_service）
{
  resetFeiyuServices()
  const w = fakeWorld()
  const r = await ensureFeiyuService({
    baseUrl: 'http://127.0.0.1:19010',
    apiKey: 'k',
    serverDir: 'C:\\fake\\server',
    pythonPath: 'C:\\fake\\python.exe',
    autoStart: true,
    startTimeoutMs: 5000,
    probeTimeoutMs: 200,
    idleStopMs: 0,
    fetchImpl: w.fetchImpl,
    spawnImpl: w.spawnImpl,
  })
  check('服务没起 → 拉起来了', r.ok === true && r.started === true, JSON.stringify(r))
  check('只 spawn 一次', w.state.spawns.length === 1, String(w.state.spawns.length))
  const argv = w.state.spawns[0]?.argv ?? []
  check('启动命令是 python -B -m feiyu_voice_service', argv[0] === 'C:\\fake\\python.exe' && argv[1] === '-B' && argv[2] === '-m' && argv[3] === 'feiyu_voice_service', argv.join(' '))
  check('端口从 baseUrl 解析出来', argv.includes('--port') && argv[argv.indexOf('--port') + 1] === '19010', argv.join(' '))
  check('cwd 是服务目录', w.state.spawns[0]?.cwd === 'C:\\fake\\server')
  check('配置文件默认取 configs/voice_service.json', argv[argv.indexOf('--config') + 1].replace(/\\/g, '/').endsWith('configs/voice_service.json'), argv[argv.indexOf('--config') + 1])
  resetFeiyuServices()
}

// 38) 服务已经起着 → 不 spawn
{
  resetFeiyuServices()
  const w = fakeWorld()
  w.state.up = true
  const r = await ensureFeiyuService({
    baseUrl: 'http://127.0.0.1:19011', serverDir: 'C:\\fake\\server', pythonPath: 'C:\\fake\\python.exe',
    startTimeoutMs: 3000, probeTimeoutMs: 200, idleStopMs: 0,
    fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl,
  })
  check('服务活着 → ok 且 started=false', r.ok === true && r.started === false, JSON.stringify(r))
  check('活着就不 spawn', w.state.spawns.length === 0, String(w.state.spawns.length))
  resetFeiyuServices()
}

// 39) 拉不起来的原因要说清：关了自动启动 / 没填目录 / 找不到 python
{
  resetFeiyuServices()
  const w = fakeWorld()
  const off = await ensureFeiyuService({
    baseUrl: 'http://127.0.0.1:19012', serverDir: 'C:\\fake\\server', autoStart: false,
    startTimeoutMs: 1000, probeTimeoutMs: 100, idleStopMs: 0, fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl,
  })
  check('关掉自动启动 → service-down（带「已关闭」）', off.ok === false && off.reason.includes('自动启动已关闭'), off.reason)

  const noDir = await ensureFeiyuService({
    baseUrl: 'http://127.0.0.1:19013', autoStart: true,
    startTimeoutMs: 1000, probeTimeoutMs: 100, idleStopMs: 0, fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl,
  })
  check('没填服务目录 → server-dir-missing', noDir.ok === false && noDir.reason === 'server-dir-missing', noDir.reason)

  const noPy = await ensureFeiyuService({
    baseUrl: 'http://127.0.0.1:19014', serverDir: dir, autoStart: true,
    startTimeoutMs: 1000, probeTimeoutMs: 100, idleStopMs: 0, fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl,
  })
  check('目录下没有 .venv → python-missing', noPy.ok === false && noPy.reason.startsWith('python-missing'), noPy.reason)
  check('这三种情况都不该 spawn', w.state.spawns.length === 0, String(w.state.spawns.length))
  resetFeiyuServices()
}

// 40) 并发来两个请求，只拉起一次（别抢同一个端口）
{
  resetFeiyuServices()
  const w = fakeWorld()
  const opts = {
    baseUrl: 'http://127.0.0.1:19015', serverDir: 'C:\\fake\\server', pythonPath: 'C:\\fake\\python.exe',
    autoStart: true, startTimeoutMs: 5000, probeTimeoutMs: 200, idleStopMs: 0,
    fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl,
  }
  const [a, b] = await Promise.all([ensureFeiyuService(opts), ensureFeiyuService(opts)])
  check('并发两路都成功', a.ok === true && b.ok === true, a.ok + '/' + b.ok)
  check('并发也只 spawn 一次', w.state.spawns.length === 1, String(w.state.spawns.length))
  resetFeiyuServices()
}

// 41) 空闲自停：到点调 shutdown 接口（不是 kill 别人的进程）
{
  resetFeiyuServices()
  const w = fakeWorld()
  const r = await ensureFeiyuService({
    baseUrl: 'http://127.0.0.1:19016', serverDir: 'C:\\fake\\server', pythonPath: 'C:\\fake\\python.exe',
    autoStart: true, startTimeoutMs: 5000, probeTimeoutMs: 200, idleStopMs: 120,
    fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl,
  })
  check('先起来', r.ok === true, JSON.stringify(r))
  await new Promise((done) => setTimeout(done, 320))
  check('空闲到点 → 调了 shutdown', w.state.shutdownCalls === 1, String(w.state.shutdownCalls))
  resetFeiyuServices()
}

// 42) 有活动就不该被停：noteFeiyuActivity 把计时器推后
{
  resetFeiyuServices()
  const w = fakeWorld()
  const baseUrl = 'http://127.0.0.1:19017'
  await ensureFeiyuService({
    baseUrl, serverDir: 'C:\\fake\\server', pythonPath: 'C:\\fake\\python.exe',
    autoStart: true, startTimeoutMs: 5000, probeTimeoutMs: 200, idleStopMs: 150,
    fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl,
  })
  for (let i = 0; i < 3; i += 1) {
    await new Promise((done) => setTimeout(done, 100))
    noteFeiyuActivity({ baseUrl, idleStopMs: 150 })
  }
  check('一直在用 → 没被停', w.state.shutdownCalls === 0, String(w.state.shutdownCalls))
  await new Promise((done) => setTimeout(done, 260))
  check('用完之后到点才停', w.state.shutdownCalls === 1, String(w.state.shutdownCalls))
  resetFeiyuServices()
}

// 43) 不是自己拉起来的进程：只发 shutdown，绝不动手 kill
{
  resetFeiyuServices()
  const w = fakeWorld()
  w.state.up = true
  await ensureFeiyuService({
    baseUrl: 'http://127.0.0.1:19018', autoStart: true, startTimeoutMs: 1000,
    probeTimeoutMs: 200, idleStopMs: 0, fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl,
  })
  const r = await stopFeiyuService('http://127.0.0.1:19018', { fetchImpl: w.fetchImpl })
  check('别人的服务 → 只发 shutdown 不 kill', r.reason === 'shutdown-api' && w.state.killed === 0, JSON.stringify(r))
  check('shutdown 真的发了', w.state.shutdownCalls === 1, String(w.state.shutdownCalls))
  const unknown = await stopFeiyuService('http://127.0.0.1:19019', { fetchImpl: w.fetchImpl })
  check('没登记过的地址 → unknown-service', unknown.stopped === false && unknown.reason === 'unknown-service', JSON.stringify(unknown))
  resetFeiyuServices()
}

// 44) 自己拉起来的：shutdown 不行才 kill
{
  resetFeiyuServices()
  const w = fakeWorld()
  const baseUrl = 'http://127.0.0.1:19020'
  await ensureFeiyuService({
    baseUrl, serverDir: 'C:\\fake\\server', pythonPath: 'C:\\fake\\python.exe',
    autoStart: true, startTimeoutMs: 5000, probeTimeoutMs: 200, idleStopMs: 0,
    fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl,
  })
  const brokenFetch = async (target) => {
    if (String(target).endsWith('/v1/admin/shutdown')) return new Response('{}', { status: 500 })
    return new Response('{}', { status: 404 })
  }
  const r = await stopFeiyuService(baseUrl, { fetchImpl: brokenFetch, graceMs: 300 })
  check('shutdown 失败 → kill 自己的进程', r.stopped === true && w.state.killed === 1, JSON.stringify(r))
  resetFeiyuServices()
}

// 45) feiyuSynthesize 会先探活：服务没起且没配目录 → 直接失败，不去发 POST
{
  resetFeiyuServices()
  const w = fakeWorld()
  const r = await feiyuSynthesize('没服务这句', {
    cacheDir: dir, baseUrl: 'http://127.0.0.1:19021', timeoutMs: 2000, pollIntervalMs: 20,
    autoStart: true, fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl,
  })
  check('没服务且没配目录 → 失败且原因是 server-dir-missing', r.ok === false && r.reason === 'server-dir-missing', r.reason)
  resetFeiyuServices()
}

// 46) 服务没起但配了目录 → 自动拉起后照常合成
{
  resetFeiyuServices()
  const w = fakeWorld()
  const fullFetch = async (target, init) => {
    const u = String(target)
    if (u.endsWith('/health')) return w.fetchImpl(u, init)
    if (u.endsWith('/v1/speech')) {
      return new Response(JSON.stringify({ job_id: 'J-AUTO' }), { status: 202, headers: { 'content-type': 'application/json' } })
    }
    if (u.endsWith('/v1/jobs/J-AUTO')) {
      return new Response(JSON.stringify({ status: 'success' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.endsWith('/v1/jobs/J-AUTO/audio')) {
      return new Response(WAV_BYTES, { status: 200, headers: { 'content-type': 'audio/wav' } })
    }
    return new Response('{}', { status: 404 })
  }
  const r = await feiyuSynthesize('自动拉起这句', {
    cacheDir: dir, baseUrl: 'http://127.0.0.1:19022',
    serverDir: 'C:\\fake\\server', pythonPath: 'C:\\fake\\python.exe',
    autoStart: true, startTimeoutMs: 5000, probeTimeoutMs: 200, idleStopMs: 0,
    timeoutMs: 5000, pollIntervalMs: 20, fetchImpl: fullFetch, spawnImpl: w.spawnImpl,
  })
  check('服务没起 → 自动拉起 → 合成成功', r.ok === true, r.ok ? r.path : r.reason)
  check('确实 spawn 了服务', w.state.spawns.length === 1, String(w.state.spawns.length))
  resetFeiyuServices()
}

// ── 47. feiyu 前缀键必须覆盖同名无前缀键（index.js 会把 edge 的 pythonPath 一起传下来）
{
  resetFeiyuServices()
  const w = fakeWorld()
  const fullFetch = async (target, init) => {
    const u = String(target)
    if (u.endsWith('/health')) return w.fetchImpl(u, init)
    if (u.endsWith('/v1/speech')) {
      return new Response(JSON.stringify({ job_id: 'J-PRE' }), { status: 202, headers: { 'content-type': 'application/json' } })
    }
    if (u.endsWith('/v1/jobs/J-PRE')) {
      return new Response(JSON.stringify({ status: 'success' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.endsWith('/v1/jobs/J-PRE/audio')) {
      return new Response(WAV_BYTES, { status: 200, headers: { 'content-type': 'audio/wav' } })
    }
    return new Response('{}', { status: 404 })
  }
  const r = await synthesize('前缀映射这句', {
    provider: 'feiyu', voice: 'feiyu', style: 'cute',
    baseUrl: 'http://127.0.0.1:19023', apiKey: 'k',
    pythonPath: 'C:\\edge\\tts-venv\\python.exe',
    feiyuServerDir: 'C:\\fake\\server', feiyuPythonPath: 'C:\\fake\\feiyu-python.exe',
    feiyuAutoStart: true, feiyuIdleStopMs: 0,
    startTimeoutMs: 5000, probeTimeoutMs: 200, timeoutMs: 5000, pollIntervalMs: 20,
    cacheDir: dir, fetchImpl: fullFetch, spawnImpl: w.spawnImpl,
  })
  check('feiyu 前缀键生效：合成成功', r.ok === true, r.ok ? r.path : r.reason)
  const argv = w.state.spawns[0]?.argv ?? []
  check('拉起肥鱼用 feiyuPythonPath，不是 edge 的 pythonPath',
    argv[0] === 'C:\\fake\\feiyu-python.exe', JSON.stringify(argv[0] ?? null))
  check('拉起肥鱼用 feiyuServerDir 当 cwd',
    w.state.spawns[0]?.cwd === 'C:\\fake\\server', JSON.stringify(w.state.spawns[0]?.cwd ?? null))
  resetFeiyuServices()
}


// ── 48. 音色预设：常量与归一化 ──
{
  check('五个音色预设都在', ['natural', 'soft', 'warm', 'deep', 'bright'].every((k) => k in VOICE_TONE_PRESETS), Object.keys(VOICE_TONE_PRESETS).join(','))
  check('默认音色 natural / 音高 0 / 语速 1',
    DEFAULT_VOICE_TONE === 'natural' && DEFAULT_VOICE_PITCH_SEMITONES === 0 && DEFAULT_VOICE_SPEED_FACTOR === 1)
  check('认不出的音色回落 natural', normalizeVoiceTone('Warm') === 'warm' && normalizeVoiceTone('nope') === 'natural' && normalizeVoiceTone('') === 'natural')
  const deep = VOICE_TONE_PRESETS.deep
  const bright = VOICE_TONE_PRESETS.bright
  check('deep 比 natural 更低更闷', deep.semitones < 0 && deep.lowpass < VOICE_TONE_PRESETS.natural.lowpass, JSON.stringify(deep))
  check('bright 更亮', bright.semitones > 0 && bright.lowpass > VOICE_TONE_PRESETS.natural.lowpass, JSON.stringify(bright))
}

// ── 49. 滤镜链：三参数怎么进 ffmpeg ──
{
  const base = buildVoiceFilterChain({})
  check('不带参数时等于默认滤镜链', base === VOICE_FILTER_CHAIN, base)
  check('滤镜链用 width_type=q（老 ffmpeg 不认 t=q）', base.includes('width_type=q') && !/(^|,)[a-z]*equalizer=f=[0-9]+:t=q/.test(base), base)

  const up = buildVoiceFilterChain({ semitones: 3 })
  check('升 3 半音 → asetrate 变大 + atempo 补时长',
    up.includes('aresample=48000') && /asetrate=5[0-9]{4}/.test(up) && up.includes('atempo='), up)

  const down = buildVoiceFilterChain({ semitones: -3 })
  const m = /asetrate=(\d+)/.exec(down)
  check('降 3 半音 → asetrate 变小', m !== null && Number(m[1]) < 48000, m ? m[1] : 'no-match')

  check('音高 0 时不插 asetrate', !buildVoiceFilterChain({ semitones: 0 }).includes('asetrate'))
  check('语速 1.15 → atempo 1.15', buildVoiceFilterChain({ speed: 1.15 }).includes('atempo=1.15'))
  check('语速 0.8 → atempo 0.8', buildVoiceFilterChain({ speed: 0.8 }).includes('atempo=0.8'))
  check('语速 1 且音高 0 时不插 atempo', !buildVoiceFilterChain({ speed: 1 }).includes('atempo'))

  const warm = buildVoiceFilterChain({ tone: 'warm' })
  check('warm 用更低的 lowpass', warm.includes('lowpass=f=10000'), warm)
  const deepChain = buildVoiceFilterChain({ tone: 'deep' })
  check('deep 叠了预设音高', deepChain.includes('asetrate='), deepChain)

  check('语速超范围会被夹住', buildVoiceFilterChain({ speed: 9 }).includes('atempo=2') && buildVoiceFilterChain({ speed: 0.1 }).includes('atempo=0.5'))
}

// ── 50. 缓存名带音色参数（改音色不能命中旧缓存）──
{
  const a = voiceCacheName('同一句话', { provider: 'feiyu', voice: 'feiyu', style: 'cute' })
  const b = voiceCacheName('同一句话', { provider: 'feiyu', voice: 'feiyu', style: 'cute', tone: 'warm' })
  const c = voiceCacheName('同一句话', { provider: 'feiyu', voice: 'feiyu', style: 'cute', tone: 'warm', semitones: -2 })
  const d = voiceCacheName('同一句话', { provider: 'feiyu', voice: 'feiyu', style: 'cute', tone: 'warm', semitones: -2, speed: 1.15 })
  check('改音色 → 换缓存名', a !== b, a + ' / ' + b)
  check('改音高 → 换缓存名', b !== c)
  check('改语速 → 换缓存名', c !== d)
  check('参数一样 → 缓存名一样',
    voiceCacheName('同一句话', { provider: 'feiyu', voice: 'feiyu', style: 'cute', tone: 'warm', semitones: -2, speed: 1.15 }) === d)
}

// ── 51. feiyuSynthesize 带音色：产物文件名带 tone 标记，WAV 原样留着 ──
{
  resetFeiyuServices()
  const w = fakeWorld()
  w.state.up = true
  const fetchAll = async (target, init) => {
    const u = String(target)
    if (u.endsWith('/health')) return w.fetchImpl(u, init)
    if (u.endsWith('/v1/speech')) return new Response(JSON.stringify({ job_id: 'J-TONE' }), { status: 202, headers: { 'content-type': 'application/json' } })
    if (u.endsWith('/v1/jobs/J-TONE')) return new Response(JSON.stringify({ status: 'success' }), { status: 200, headers: { 'content-type': 'application/json' } })
    if (u.endsWith('/v1/jobs/J-TONE/audio')) return new Response(WAV_BYTES, { status: 200, headers: { 'content-type': 'audio/wav' } })
    return new Response('{}', { status: 404 })
  }
  const plain = await feiyuSynthesize('音色测试这句', {
    cacheDir: dir, baseUrl: 'http://127.0.0.1:19031', apiKey: 'k', voice: 'feiyu', style: 'cute',
    autoStart: false, idleStopMs: 0, timeoutMs: 5000, pollIntervalMs: 20,
    fetchImpl: fetchAll, ffmpegPath: join(dir, 'no-such-ffmpeg.exe'),
  })
  check('不带音色：合成成功', plain.ok === true, plain.ok ? plain.path : plain.reason)

  const toned = await feiyuSynthesize('音色测试这句', {
    cacheDir: dir, baseUrl: 'http://127.0.0.1:19031', apiKey: 'k', voice: 'feiyu', style: 'cute',
    autoStart: false, idleStopMs: 0, timeoutMs: 5000, pollIntervalMs: 20,
    tone: 'deep', semitones: -2, speed: 1.1,
    fetchImpl: fetchAll, ffmpegPath: join(dir, 'no-such-ffmpeg.exe'),
  })
  check('带音色：合成成功（没 ffmpeg 就回落原 WAV）', toned.ok === true, toned.ok ? toned.path : toned.reason)
  check('带音色：WAV 仍留在原路径（不用重新合成）', toned.wavPath === plain.wavPath, String(toned.wavPath))
  resetFeiyuServices()
}

// ── 52. 真 ffmpeg：音色滤镜真跑一次（设了 DSH_TTS_TEST_FFMPEG 才跑）──
{
  const ff = String(process.env.DSH_TTS_TEST_FFMPEG || '').trim()
  if (ff === '') {
    console.log('SKIP  真音色滤镜（没设 DSH_TTS_TEST_FFMPEG）')
  } else {
    // 8kHz 单声道 1 秒 440Hz 正弦，ffmpeg 解得开
    const n = 8000
    const buf = Buffer.alloc(44 + n * 2)
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8)
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
    buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
    for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 8000) * 12000), 44 + i * 2)
    const src = join(dir, 'tone-src.wav')
    writeFileSync(src, buf)

    const plainOut = await ensureRecordAudio(src, { ffmpegPath: ff, timeoutMs: 20000 })
    check('真 ffmpeg：默认滤镜链跑通', plainOut.converted === true, plainOut.reason ?? plainOut.path)

    const warmOut = await ensureRecordAudio(src, {
      ffmpegPath: ff, timeoutMs: 20000,
      filterChain: buildVoiceFilterChain({ tone: 'warm', semitones: -2, speed: 1.1 }),
      dst: join(dir, 'tone-warm.mp3'),
    })
    check('真 ffmpeg：音色链（warm + 降 2 半音 + 1.1 倍速）跑通', warmOut.converted === true, warmOut.reason ?? warmOut.path)
    check('真 ffmpeg：音色产物落在指定 dst', warmOut.path === join(dir, 'tone-warm.mp3'), warmOut.path)
    check('真 ffmpeg：音色产物非空', existsSync(warmOut.path) && statSync(warmOut.path).size > 0, String(existsSync(warmOut.path) ? statSync(warmOut.path).size : 0))
  }
}


// ── 语气预设 ───────────────────────────────────────────────
{
  check('语气：默认语气不改任何参数', (() => {
    const p = voiceMoodPreset(DEFAULT_VOICE_MOOD)
    return p.style === '' && p.tone === 'natural' && p.semitones === 0 && p.speed === 1
  })(), JSON.stringify(voiceMoodPreset(DEFAULT_VOICE_MOOD)))

  check('语气：六个预设都在表里', Object.keys(VOICE_MOOD_PRESETS).length === 6, String(Object.keys(VOICE_MOOD_PRESETS).length))
  check('语气：撒娇会改用 cute 并略升调', voiceMoodPreset('sweet').style === 'cute' && voiceMoodPreset('sweet').semitones > 0, JSON.stringify(voiceMoodPreset('sweet')))
  check('语气：温柔会改用 gentle 并放慢', voiceMoodPreset('gentle').style === 'gentle' && voiceMoodPreset('gentle').speed < 1, JSON.stringify(voiceMoodPreset('gentle')))
  check('语气：困倦最慢最沉', voiceMoodPreset('sleepy').speed < voiceMoodPreset('gentle').speed && voiceMoodPreset('sleepy').semitones < 0, JSON.stringify(voiceMoodPreset('sleepy')))
  check('语气：认不出的值回落默认', normalizeVoiceMood('nope') === DEFAULT_VOICE_MOOD && normalizeVoiceMood('Sweet') === 'sweet', normalizeVoiceMood('nope') + '/' + normalizeVoiceMood('Sweet'))

  // 语气落到滤镜链上：元气比默认更高更快，困倦更低更慢。
  // 注意：soft 预设自带 -1 半音，撒娇的 +1 会正好抵消，所以用 lively（bright +1.5 + 2）验变调。
  const chainDefault = buildVoiceFilterChain({ tone: 'natural', semitones: 0, speed: 1 })
  const pLively = voiceMoodPreset('lively')
  const chainLively = buildVoiceFilterChain({ tone: pLively.tone, semitones: pLively.semitones, speed: pLively.speed })
  check('语气：元气的链带变调（比默认高）', chainLively !== chainDefault && chainLively.includes('asetrate'), chainLively.slice(0, 60))
  const pSleepy = voiceMoodPreset('sleepy')
  const chainSleepy = buildVoiceFilterChain({ tone: pSleepy.tone, semitones: pSleepy.semitones, speed: pSleepy.speed })
  check('语气：困倦的链带变调（比默认低）', chainSleepy.includes('asetrate') && chainSleepy !== chainDefault, chainSleepy.slice(0, 60))

  // feiyuSynthesize：语气会改写 style，缓存名也跟着变。
  const moodDir = mkdtempSync(join(tmpdir(), "mood-"))
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'job-m', status: 'queued' }) })
  const moodRes = await feiyuSynthesize('测试语气', {
    baseUrl: 'http://127.0.0.1:1', apiKey: 'k', cacheDir: moodDir, mood: 'gentle',
    autoStart: false, fetchImpl: fakeFetch,
  })
  check('语气：服务不可用时照样按失败返回（不吞异常）', moodRes.ok === false, JSON.stringify(moodRes))
  rmSync(moodDir, { recursive: true, force: true })
}

rmSync(dir, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
