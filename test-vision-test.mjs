#!/usr/bin/env node
/**
 * 看图「测试识图」按钮 —— 离线测试。
 *
 * 后端：真跑 apply(ctx) 注册出 /vision/test 路由，构造回环 POST 请求打它，
 *       用假 llm/attachments 走一遍 describeImage 的 forced 路径。
 * 前端：真跑 client bundle，切到「看图」页，点「测试识图」按钮，
 *       验 fetch 的 URL / payload（固定档强指定模型，其余档交后端），以及结果/error 的渲染。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { apply, PLUGIN_VERSION } from './index.js'

let pass = 0
const failures = []
function check(name, ok, detail) {
  if (ok) { pass += 1; return }
  failures.push(`${name}${detail === undefined ? '' : `  →  ${detail}`}`)
}
const slice = (s, n = 200) => String(s ?? '').slice(0, n)

// ══════════════════════════════════════════════════════════════════════════
// 后端：/vision/test 路由
// ══════════════════════════════════════════════════════════════════════════
{
  const dir = mkdtempSync(join(tmpdir(), 'qq-vision-test-'))
  const statePath = join(dir, 'state.json')
  writeFileSync(statePath, `${JSON.stringify({ buffer: [] })}\n`, 'utf8')

  const warnings = []
  const routes = []
  const streamed = []
  const savedImages = []
  const llm = {
    listProviders: () => [{ id: 'prov-auto' }],
    listModels: async () => [{ id: 'auto-m', name: '自动视觉模型', inputModalities: ['image'] }],
    stream: async function* (opts) {
      streamed.push(`${opts.provider}/${opts.model}`)
      yield { type: 'text-delta', text: 'VISION TEST' }
      yield { type: 'text-delta', text: ' 2026 ALPHA-7391' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const ctx = {
    logger: { info() {}, warn: (m) => warnings.push(String(m)), debug() {} },
    settings: { describe: () => [], update: async () => {}, configure: () => () => {} },
    agents: { get: () => undefined, roots: () => [], resume: async () => {} },
    tools: { register: () => {} },
    on: () => () => {},
    effect: () => {},
    get: (name) => {
      if (name === 'llm') return llm
      if (name === 'attachments') {
        return {
          imageLimits: { maxImagesPerMessage: 4 },
          saveImage: async (arg) => { savedImages.push(arg); return { id: 'vt-att', mediaType: arg.mediaType } },
        }
      }
      return undefined
    },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
  }
  ctx.inject = (_deps, cb) => cb(ctx)
  apply(ctx, {
    statePath,
    targetSessionId: 'session-vt',
    debugTools: false,
    onebotUrl: '',
    wakeProbability: 0,
    groupWhitelist: [],
    napcatInstallDir: join(dir, 'no-napcat'),
  })

  const route = routes.find((r) => r.path === '/api/qq-bridge-neko/vision/test')
  check('注册了 /vision/test 路由', Boolean(route))
  check('内置测试图随包存在', existsSync(join(dirname(fileURLToPath(import.meta.url)), 'assets', 'vision-test.png')))

  const call = async (method, bodyText) => {
    const out = { status: 0, headers: {}, body: '' }
    const req = {
      method,
      url: '/api/qq-bridge-neko/vision/test',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { if (bodyText !== undefined) yield Buffer.from(bodyText) },
    }
    const res = {
      writeHead: (s, h) => { out.status = s; out.headers = h || {} },
      end: (b) => { out.body = String(b ?? '') },
    }
    await route.handler(req, res)
    let json = null
    try { json = JSON.parse(out.body) } catch { /* 405 也可能是空 body */ }
    return { ...out, json }
  }

  // ① GET → 405
  const got = await call('GET')
  check('GET 被拒（405）', got.status === 405 && got.json?.ok === false, `status=${got.status} body=${slice(got.body)}`)

  // ② 非法 JSON → 400
  const bad = await call('POST', '{not json')
  check('非法 JSON 请求体 → 400', bad.status === 400 && bad.json?.ok === false, `status=${bad.status} body=${slice(bad.body)}`)

  // ③ 强制指定模型（核心：测「当前选中的模型」）→ 成功，回显 provider/model/requested
  streamed.length = 0
  savedImages.length = 0
  const ok = await call('POST', JSON.stringify({ provider: 'my-prov', model: 'my-model' }))
  check(
    'POST 强制模型 → ok:true 且识别文字回来了',
    ok.status === 200 && ok.json?.ok === true && String(ok.json?.text).includes('ALPHA-7391'),
    `status=${ok.status} body=${slice(ok.body)}`,
  )
  check('回显实际 provider/model', ok.json?.provider === 'my-prov' && ok.json?.model === 'my-model', slice(ok.body))
  check('回显 requested（调用方强指定的那套）', ok.json?.requested?.provider === 'my-prov' && ok.json?.requested?.model === 'my-model', slice(ok.body))
  check('elapsedMs 是数字', typeof ok.json?.elapsedMs === 'number' && ok.json.elapsedMs >= 0, slice(ok.body))
  check('stream 走的正是强指定的模型', streamed.length > 0 && streamed.every((s) => s === 'my-prov/my-model'), streamed.join(','))
  check('确实把内置图存进了 attachments', savedImages.length > 0 && savedImages[0].mediaType === 'image/png', JSON.stringify(savedImages.map((s) => s.mediaType)))

  // ④ 空 body → 不强制，交给 findVisionModel 自动解析（auto 档扫到 vision 模型）
  streamed.length = 0
  const auto = await call('POST', '')
  check(
    'POST 空 body → 自动选模型也能跑通',
    auto.status === 200 && auto.json?.ok === true && typeof auto.json?.elapsedMs === 'number',
    `status=${auto.status} body=${slice(auto.body)}`,
  )
  check('自动档没有 requested 字段', auto.json?.requested === undefined, slice(auto.body))
  check('自动档 stream 走自动解析的模型', streamed.length > 0 && streamed[0] === 'prov-auto/auto-m', streamed.join(','))
}

// ══════════════════════════════════════════════════════════════════════════
// 前端：VisionTest 组件
// ══════════════════════════════════════════════════════════════════════════
{
  const source = readFileSyncLocal('client/client.js')
  let def
  const fetchCalls = []
  let nextFetch = { ok: true, body: { ok: true, text: 'VISION TEST 2026 ALPHA-7391', provider: 'p', model: 'm', elapsedMs: 12 } }
  const sandbox = {
    console,
    fetch: async (url, opts) => {
      fetchCalls.push({ url, opts })
      return { ok: nextFetch.ok, status: 200, json: async () => nextFetch.body }
    },
    window: { __ModuleLoader__: { load: (d) => { def = d } } },
  }
  vm.runInNewContext(source, sandbox)

  const stateBuckets = new Map()
  let renderingComponent = null
  let stateCursor = 0
  const fakeReact = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useState: (init) => {
      const key = renderingComponent ?? 'anon'
      if (!stateBuckets.has(key)) stateBuckets.set(key, [])
      const bucket = stateBuckets.get(key)
      const index = stateCursor
      stateCursor += 1
      if (!(index in bucket)) bucket[index] = typeof init === 'function' ? init() : init
      const set = (next) => { bucket[index] = typeof next === 'function' ? next(bucket[index]) : next }
      return [bucket[index], set]
    },
    useEffect: () => {},
    useRef: (init) => ({ current: init }),
    useSyncExternalStore: (_sub, get) => {
      try { const s = typeof get === 'function' ? get() : undefined; return s && typeof s === 'object' ? s : { status: 'loading' } }
      catch { return { status: 'loading' } }
    },
  }
  const mod = def.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`require 了非 baseline 模块：${name}`)
  })
  const FIELDS = mod.__test?.fields ?? []
  const base = Object.fromEntries(
    FIELDS.map((f) => [f.key, f.kind === 'boolean' ? false : f.kind === 'list' || f.kind === 'group-list' ? [] : '']),
  )
  base.ttsProvider = 'edge'

  function expand(node, depth = 0) {
    if (Array.isArray(node)) return node.map((c) => expand(c, depth))
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function' && depth < 16) {
      const outer = renderingComponent
      renderingComponent = node.type
      stateCursor = 0
      const rendered = node.type({ ...node.props, children: node.children })
      renderingComponent = outer
      return expand(rendered, depth + 1)
    }
    return { ...node, children: (node.children ?? []).map((c) => expand(c, depth)) }
  }
  function walk(node, visit) {
    if (!node || typeof node !== 'object') return
    visit(node)
    for (const child of node.children ?? []) walk(child, visit)
  }
  function all(node) { const out = []; walk(node, (n) => out.push(n)); return out }
  function textOf(node) {
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (!node || typeof node !== 'object') return ''
    return (node.children ?? []).map(textOf).join('')
  }

  function renderVision(settingsValue) {
    // 每个场景干净起步：假 react 按组件函数分桶，Card / VisionTest 都是模块级同一函数，
    // 不清空的话上一场景的 result/error 会串到这一场景。
    stateBuckets.clear()
    const registry = []
    const snapshot = { status: 'ready', value: settingsValue, writable: true, overridden: [] }
    const bindable = {
      bind: () => ({
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
        set: async () => {},
        unset: async () => {},
      }),
    }
    const fakeCtx = {
      get: () => undefined,
      inject: (_d, cb) => cb(fakeCtx),
      settingsScope: bindable,
      slots: {
        inject: (_n, cb) => cb(),
        register: (options, cell) => { registry.push({ options, cell }); return () => {} },
      },
    }
    mod.apply(fakeCtx)
    const tab = registry.find((r) => r.options.name === 'settings.plugins.tab')
    const cell = tab.cell()
    // 先展开一次让 Card 的 state bucket 建起来，再把页签切到「看图」。
    expand(cell)
    const cardFn = cell.type
    const bucket = stateBuckets.get(cardFn)
    if (bucket) bucket[5] = 'vision'
    return cell
  }

  // ① 看图页有「测试识图」按钮
  let cell = renderVision(base)
  let tree = expand(cell)
  const testBtns = all(tree).filter((n) => n.type === 'button' && textOf(n).includes('测试识图'))
  check('看图页渲染出「测试识图」按钮', testBtns.length >= 1, String(testBtns.length))
  check('按钮旁边有用法说明', all(tree).some((n) => textOf(n).includes('走真实识图链路')))

  // ② auto 档：点按钮 → POST 空 payload（交给后端自动解析）
  fetchCalls.length = 0
  nextFetch = { ok: true, body: { ok: true, text: 'VISION TEST 2026 ALPHA-7391', provider: 'p', model: 'm', elapsedMs: 12 } }
  const btnAuto = all(expand(cell)).find((n) => n.type === 'button' && textOf(n).includes('测试识图'))
  await btnAuto.props.onClick()
  check('auto 档也打 /vision/test', fetchCalls.length === 1 && fetchCalls[0].url === '/api/qq-bridge-neko/vision/test', JSON.stringify(fetchCalls.map((c) => c.url)))
  check('auto 档 payload 为空对象（不强指定模型）', fetchCalls[0] && JSON.stringify(JSON.parse(fetchCalls[0].opts.body)) === '{}', fetchCalls[0]?.opts?.body)

  // ③ 成功后重渲染：结果块出现，模型/耗时/识别文字都在
  tree = expand(cell)
  check('成功后显示「识别结果」', all(tree).some((n) => textOf(n).includes('识别结果')))
  check('结果块显示实际模型与耗时', all(tree).some((n) => textOf(n).includes('p / m') && textOf(n).includes('12 ms')))
  check('结果块里认出的文字可读', all(tree).some((n) => n.type === 'textarea' && String(n.props?.value).includes('ALPHA-7391')))

  // ④ 固定档：强指定 provider/model
  const fixedCell = renderVision({ ...base, visionMode: 'fixed', visionProvider: 'fp', visionProviderModel: 'fm' })
  fetchCalls.length = 0
  const btnFixed = all(expand(fixedCell)).find((n) => n.type === 'button' && textOf(n).includes('测试识图'))
  await btnFixed.props.onClick()
  const payload = fetchCalls[0] ? JSON.parse(fetchCalls[0].opts.body) : null
  check('固定档强指定当前选中的模型', payload?.provider === 'fp' && payload?.model === 'fm', JSON.stringify(payload))

  // ⑤ 失败：后端回 ok:false → 显示 error，不显示结果
  const failCell = renderVision(base)
  fetchCalls.length = 0
  nextFetch = { ok: true, body: { ok: false, reason: '没找到支持图片输入的模型' } }
  const btnFail = all(expand(failCell)).find((n) => n.type === 'button' && textOf(n).includes('测试识图'))
  await btnFail.props.onClick()
  const failTree = expand(failCell)
  check('失败时显示原因', all(failTree).some((n) => textOf(n).includes('没找到支持图片输入的模型')))
  check('失败时不显示识别结果', !all(failTree).some((n) => textOf(n).includes('识别结果')))
}

// ── 小工具：相对仓库根读文件 ──────────────────────────────────────────────
function readFileSyncLocal(rel) {
  // eslint-disable-next-line no-undef
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), rel), 'utf8')
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 条失败：`)
  for (const line of failures) console.error(`  - ${line}`)
  console.error(`\n通过 ${pass} 条\n`)
  process.exit(1)
}
console.log(`✓ 全部通过（${pass} 条） · PLUGIN_VERSION=${PLUGIN_VERSION}`)
