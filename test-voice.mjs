// voice.js 单测：切块 / 缓存名 / record 段 / 合成失败路径。纯离线，零依赖。
// 运行：node test-voice.mjs
// 合成部分只在 DSH_TTS_TEST_PYTHON 指向装了 edge-tts 的解释器时才真跑，
// 否则只验「解释器不存在时优雅失败」。
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_TTS_PITCH,
  DEFAULT_TTS_RATE,
  DEFAULT_TTS_VOICE,
  hasVoiceBlock,
  recordSegment,
  splitVoiceBlocks,
  stripVoiceBlocks,
  synthesize,
  voiceCacheName,
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

rmSync(dir, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
