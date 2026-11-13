// test-feiyu-voice-options.mjs — 肥鱼音色下拉的两半：宿主半的探测 + 客户端的渲染。
//
// 这里不抄一份逻辑来测，而是把 index.js / client/client.js 里那两个函数**原文切出来**，
// 配上最小桩子真跑：
//   * `readFeiyuVoiceOptions()`：起一个真 HTTP 假服务，覆盖在线 / 离线 / 口令错 / 坏地址 / 空注册；
//   * `renderFeiyuVoice()`：用假 `h()` 记录生成的选项，覆盖兜底项、未知当前值、无 catalog。
//
// 两条都只依赖 Node 内置模块，`node test-feiyu-voice-options.mjs` 直接跑。

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const INDEX_SRC = join(ROOT, 'index.js')
const CLIENT_SRC = join(ROOT, 'client', 'client.js')

let failed = 0
function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}`)
    return
  }
  failed += 1
  console.log(`FAIL  ${name}  → ${JSON.stringify(detail)}`)
}

/** 从源码里切出一个具名函数（按花括号配对收尾）。 */
function sliceFunction(source, signature) {
  const start = source.indexOf(signature)
  if (start < 0) throw new Error(`找不到函数：${signature}`)
  let depth = 0
  let i = source.indexOf('{', start)
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) {
        i += 1
        break
      }
    }
  }
  return source.slice(start, i)
}

/** 把切出来的函数体写成临时模块并 import，跑完删掉。 */
async function loadTemp(body) {
  const file = join(ROOT, `.tmp-test-${randomUUID().slice(0, 8)}.mjs`)
  writeFileSync(file, body, 'utf8')
  try {
    return await import(pathToFileURL(file).href)
  } finally {
    try {
      unlinkSync(file)
    } catch {
      /* 忽略 */
    }
  }
}

const indexSource = readFileSync(INDEX_SRC, 'utf8')
const clientSource = readFileSync(CLIENT_SRC, 'utf8')

// ── 宿主半：readFeiyuVoiceOptions() ────────────────────────────────────────
const probeBody = sliceFunction(indexSource, 'async function readFeiyuVoiceOptions()')

async function loadProbe(settings) {
  const prelude = [
    "const DEFAULT_FEIYU_VOICE = 'feiyu'",
    "const DEFAULT_FEIYU_BASE_URL = 'http://127.0.0.1:9880'",
    "const FEIYU_STYLES = ['cute', 'gentle']",
    `const SETTINGS = ${JSON.stringify(settings)}`,
    'function readSettings() { return SETTINGS }',
  ].join('\n')
  const mod = await loadTemp(`${prelude}\n${probeBody}\nexport { readFeiyuVoiceOptions }\n`)
  return mod.readFeiyuVoiceOptions
}

// 1) 服务没起：兜底项 + 原因，语气清单不受影响
{
  const probe = await loadProbe({ feiyuBaseUrl: 'http://127.0.0.1:5987', feiyuApiKey: '' })
  const r = await probe()
  check('离线：只剩内置 feiyu', r.voices.length === 1 && r.voices[0].id === 'feiyu', r)
  check('离线：online=false', r.online === false, r)
  check('离线：带一句原因', typeof r.note === 'string' && r.note !== '', r)
  check('离线：语气仍是 cute/gentle', r.styles.join(',') === 'cute,gentle', r)
}

// 2) 服务在线、注册了三个音色（其中一个是 RVC、一个不可用）
const server = createServer((req, res) => {
  if (req.url !== '/v1/capabilities') {
    res.writeHead(404)
    res.end()
    return
  }
  if (String(req.headers.authorization ?? '') !== 'Bearer testkey') {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ detail: 'no' }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    tts: [
      { voice: 'feiyu', engine: 'cosyvoice3_release', available: true, styles: ['cute', 'gentle'] },
      { voice: 'luna', engine: 'cosyvoice3_release', available: false, styles: ['lively'], reason: 'package missing' },
    ],
    rvc: [{ voice: 'a60', available: true }],
    singing: { available: true, formats: ['midi', 'abc'] },
  }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

{
  const probe = await loadProbe({ feiyuBaseUrl: `http://127.0.0.1:${port}`, feiyuApiKey: 'testkey' })
  const r = await probe()
  check('在线：tts + rvc 都收进来', r.voices.map((v) => v.id).join(',') === 'feiyu,luna,a60', r)
  check('在线：online=true', r.online === true, r)
  check('在线：语气取并集', r.styles.includes('lively') && r.styles.includes('cute'), r)
  check('在线：不可用音色带原因', r.voices[1].available === false && typeof r.voices[1].reason === 'string', r)
  check('在线：默认音色取第一个', r.defaultVoice === 'feiyu', r)
  check('在线：带唱歌能力', r.singing?.available === true, r)
}

// 3) 口令不对
{
  const probe = await loadProbe({ feiyuBaseUrl: `http://127.0.0.1:${port}`, feiyuApiKey: 'wrong' })
  const r = await probe()
  check('口令错：兜底 + 说明里带 401', r.voices.length === 1 && /401/.test(String(r.note)), r)
}

// 4) 地址不合法
{
  const probe = await loadProbe({ feiyuBaseUrl: 'not a url', feiyuApiKey: '' })
  const r = await probe()
  check('坏地址：兜底 + 说明', r.voices.length === 1 && typeof r.note === 'string', r)
}

server.close()

// ── 客户端半：renderFeiyuVoice() ───────────────────────────────────────────
const renderBody = sliceFunction(clientSource, 'function renderFeiyuVoice(field, cur)')

async function loadRenderer() {
  const prelude = [
    'const S = { input: {}, hint: {} }',
    // 主题令牌与 option 样式是模块级常量，切函数时要一起带上（否则切片里引用不到）
    "const OPTION_STYLE = { background: 'surface', color: 'text' }",
    'const snap = { writable: true }',
    'const busy = false',
    'let catalog = null',
    'const change = () => () => {}',
    'function h(tag, props, ...rest) {',
    '  const children = []',
    '  for (const item of rest) {',
    '    if (Array.isArray(item)) children.push(...item)',
    '    else if (item !== null && item !== undefined && item !== false) children.push(item)',
    '  }',
    '  return { tag, props: props || {}, children }',
    '}',
  ].join('\n')
  const tail = '\nexport { renderFeiyuVoice, setCatalog }\nfunction setCatalog(v) { catalog = v }\n'
  return await loadTemp(`${prelude}\n${renderBody}${tail}`)
}

const renderer = await loadRenderer()
const field = {
  key: 'feiyuVoice',
  label: '肥鱼音色',
  kind: 'feiyu-voice',
  options: [['feiyu', 'feiyu（默认音色）']],
}

/** 取渲染结果里的选项与提示。 */
function readNode(node) {
  const select = node.children.find((c) => c && c.tag === 'select')
  const hint = node.children.find((c) => c && c.tag === 'div')
  const options = (select?.children ?? []).map((o) => [o.props.value, String(o.children)])
  return { options, hint: hint === undefined ? '' : String(hint.children) }
}

// 5) 离线：只有内置项，下面写原因
{
  renderer.setCatalog({
    feiyuVoices: {
      voices: [{ id: 'feiyu', styles: ['cute', 'gentle'] }],
      online: false,
      note: '连不上服务（ECONNREFUSED）',
    },
  })
  const { options, hint } = readNode(renderer.renderFeiyuVoice(field, 'feiyu'))
  check('离线：只有 feiyu', options.length === 1 && options[0][0] === 'feiyu', options)
  check('离线：提示带原因', /连不上服务/.test(hint), hint)
}

// 6) 旧配置里的音色不在清单里：保留成兜底项，别静默清空
{
  renderer.setCatalog({ feiyuVoices: { voices: [{ id: 'feiyu', styles: ['cute'] }], online: true } })
  const { options } = readNode(renderer.renderFeiyuVoice(field, 'legacy_voice'))
  check('未知当前值：保留成选项', options.some(([v]) => v === 'legacy_voice'), options)
  check('未知当前值：标「不在清单里」', options.some(([v, t]) => v === 'legacy_voice' && /不在清单里/.test(t)), options)
}

// 7) catalog 没拿到：退回字段自带的静态选项，不显示错误
{
  renderer.setCatalog(null)
  const node = renderer.renderFeiyuVoice(field, 'feiyu')
  const { options, hint } = readNode(node)
  check('无 catalog：用静态选项', options.length === 1 && options[0][0] === 'feiyu', options)
  check('无 catalog：不显示提示', hint === '' && node.children.length === 1, node.children.length)
}

// 8) 在线多音色：标签带语气 / 换声 / 不可用
{
  renderer.setCatalog({
    feiyuVoices: {
      voices: [
        { id: 'feiyu', kind: 'tts', styles: ['cute', 'gentle'], available: true },
        { id: 'luna', kind: 'tts', styles: ['lively'], available: false },
        { id: 'a60', kind: 'rvc', styles: [], available: true },
      ],
      online: true,
    },
  })
  const { options } = readNode(renderer.renderFeiyuVoice(field, 'feiyu'))
  check('在线：三个音色都在', options.map(([v]) => v).join(',') === 'feiyu,luna,a60', options)
  check('在线：标签带语气', /语气 cute \/ gentle/.test(options[0][1]), options)
  check('在线：不可用有标记', /不可用/.test(options[1][1]), options)
  check('在线：换声有标记', /换声/.test(options[2][1]), options)
}

// 9) 在线但一个音色都没注册：仍给兜底项，并说明
{
  renderer.setCatalog({
    feiyuVoices: {
      voices: [{ id: 'feiyu', styles: ['cute'] }],
      online: true,
      note: '服务在跑，但没有注册任何音色',
    },
  })
  const { options, hint } = readNode(renderer.renderFeiyuVoice(field, 'feiyu'))
  check('空注册：仍有 feiyu', options.some(([v]) => v === 'feiyu'), options)
  check('空注册：提示没注册', /没有注册任何音色/.test(hint), hint)
}

if (failed > 0) {
  console.log(`\n${failed} 条失败`)
  process.exit(1)
}
console.log('\nALL PASS')
