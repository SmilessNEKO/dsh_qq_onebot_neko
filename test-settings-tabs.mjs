#!/usr/bin/env node
/**
 * 设置页分类 + 声音模块二选一 + 左下角入口 —— 离线测试。
 *
 * 真把浏览器半的 bundle 跑一遍：假 `window.__ModuleLoader__`、假 react、假 ctx。
 * 不做源码字符串匹配，因为这里的失败形态是「界面上静默少一片」：
 * 字段漏归类、kind 忘了接分支、slot 名写错 —— 只有真跑一次注册与渲染才拦得住。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const source = readFileSync(fileURLToPath(new URL('./client/client.js', import.meta.url)), 'utf8')

let pass = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    pass += 1
    return
  }
  failures.push(`${name}${detail === undefined ? '' : `  →  ${detail}`}`)
}

// ── 装载 bundle ────────────────────────────────────────────────────────────
let def
const sandbox = { window: { __ModuleLoader__: { load: (d) => { def = d } } }, console }
vm.runInNewContext(source, sandbox)
check('bundle 被 __ModuleLoader__ 装载', Boolean(def?.factory))

// ── 假 react ──────────────────────────────────────────────────────────────
// 状态按「组件函数」分桶，和 React 的实例语义一致：同一个 Card 反复渲染共享状态，
// 不同组件（Card / FootEntry）互不干扰。这样才能模拟「切页签后再渲染一次」。
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
    const set = (next) => {
      bucket[index] = typeof next === 'function' ? next(bucket[index]) : next
    }
    return [bucket[index], set]
  },
  useEffect: () => {},
  useSyncExternalStore: (_subscribe, get) => {
    try {
      const snap = typeof get === 'function' ? get() : undefined
      return snap && typeof snap === 'object' ? snap : { status: 'loading' }
    } catch {
      return { status: 'loading' }
    }
  },
}
const mod = def.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error(`require 了非 baseline 模块：${name}`)
})

const FIELDS = mod.__test?.fields ?? []
const GROUPS = mod.__test?.groups ?? []
const fieldKeys = FIELDS.map((f) => f.key)

// ── 渲染树工具 ────────────────────────────────────────────────────────────
/** 手动展开函数组件（假 react 不会自己跑它们）。 */
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
function all(node) {
  const out = []
  walk(node, (n) => out.push(n))
  return out
}
function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}
function buttons(node) {
  return all(node).filter((n) => n.type === 'button')
}
/** 渲染树里出现的设置字段 key（行容器的 key 就是字段 key）。 */
function shownKeys(node) {
  return new Set(
    all(node)
      .map((n) => n.props?.key)
      .filter((k) => typeof k === 'string' && fieldKeys.includes(k)),
  )
}

// ── 起一张卡片 ─────────────────────────────────────────────────────────────
let registry = []

function renderCard(settingsValue) {
  registry = []
  // 用宿主设置服务这条真实路径注入快照：`bindSettings` 会在 `ready` 的命名空间上用它。
  // 直接给 apiBoundScope 是走不通的 —— 那条路要 fetch，沙箱里没有。
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
    inject: (_deps, cb) => cb(fakeCtx),
    settingsScope: bindable,
    slots: {
      inject: (_name, cb) => cb(),
      register: (options, cell) => {
        registry.push({ options, cell })
        return () => {}
      },
    },
  }
  mod.apply(fakeCtx)
  const tab = registry.find((r) => r.options.name === 'settings.plugins.tab')
  if (!tab) throw new Error('设置卡片没挂上')
  return { tab }
}

const base = Object.fromEntries(
  FIELDS.map((f) => [f.key, f.kind === 'boolean' ? false : f.kind === 'list' || f.kind === 'group-list' ? [] : '']),
)
base.ttsProvider = 'edge'

/** 渲染一张卡片，并（可选）把分类切到某一页。 */
function renderAt(groupId, settingsValue = base) {
  const { tab } = renderCard(settingsValue)
  if (groupId) {
    // 先把页签状态设成目标页（Card 的 activeGroup 是第 6 个 state，索引 5）
    const cardFn = tab.cell().type
    const bucket = stateBuckets.get(cardFn)
    if (bucket) bucket[5] = groupId
  }
  return tab.cell()
}

// ── 1. 分类必须覆盖每一个字段 ───────────────────────────────────────────────
{
  check('exports 里能拿到 GROUPS（便于排障与测试）', Array.isArray(GROUPS) && GROUPS.length > 0)
  const listed = new Set(GROUPS.reduce((acc, g) => acc.concat(g.keys), []))
  const missing = fieldKeys.filter((k) => !listed.has(k))
  const extra = [...listed].filter((k) => !fieldKeys.includes(k))
  check('每个设置字段都归进了某一类（漏了就在任何页都点不到）', missing.length === 0, missing.join(', '))
  check('分类里没有不存在的键', extra.length === 0, extra.join(', '))
  const dup = GROUPS.flatMap((g) => g.keys).filter((k, i, arr) => arr.indexOf(k) !== i)
  check('同一个字段只出现在一类里', dup.length === 0, dup.join(', '))
  check('分类都有中文名', GROUPS.every((g) => typeof g.label === 'string' && g.label.trim() !== ''))
}

// ── 2. 页签渲染与分页 ──────────────────────────────────────────────────────
{
  const tree = expand(renderAt('connect'))
  const labels = GROUPS.map((g) => g.label)
  const tabButtons = buttons(tree).filter((b) => labels.includes(textOf(b)))
  check('页签全都渲染出来了', tabButtons.length === GROUPS.length, `${tabButtons.length}/${GROUPS.length}`)

  const connectKeys = shownKeys(tree)
  const connectGroup = GROUPS.find((g) => g.id === 'connect')
  const missingConnect = connectGroup.keys.filter((k) => !connectKeys.has(k))
  check('只看「连接」页时该页字段都在', missingConnect.length === 0, missingConnect.join(', '))

  const otherKeys = GROUPS.filter((g) => g.id !== 'connect')
    .reduce((acc, g) => acc.concat(g.keys), [])
    .filter((k) => connectKeys.has(k))
  check('别的页的字段不会混进来', otherKeys.length === 0, otherKeys.join(', '))

  const voiceTree = expand(renderAt('voice'))
  const voiceKeys = shownKeys(voiceTree)
  check('切到「声音」页就是声音的字段', voiceKeys.has('ttsProvider') && voiceKeys.has('voiceEnabled'))
  check('切页后连接那页的字段不再出现', !voiceKeys.has('onebotUrl'))
}

// ── 3. 声音模块：二选一 ────────────────────────────────────────────────────
{
  check('有一个「声音」分类', GROUPS.some((g) => g.id === 'voice'))
  const providerField = FIELDS.find((f) => f.key === 'ttsProvider')
  check('ttsProvider 换成 voice-module 控件', providerField?.kind === 'voice-module', String(providerField?.kind))

  const localTree = expand(renderAt('voice', { ...base, ttsProvider: 'edge' }))
  const localKeys = shownKeys(localTree)
  check('选 edge 时显示本地那套（ttsVoice / ttsModelDir）', localKeys.has('ttsVoice') && localKeys.has('ttsModelDir'))
  check(
    '选 edge 时肥鱼那套收起来',
    !localKeys.has('feiyuBaseUrl') && !localKeys.has('feiyuVoice'),
    [...localKeys].filter((k) => k.startsWith('feiyu')).join(', '),
  )
  check('两个模块都列出来可选', ['本地合成', '肥鱼声音服务'].every((t) => all(localTree).some((n) => textOf(n).includes(t))))
  check('本地两组引擎都给了按钮', ['edge-tts', 'sherpa'].every((t) => buttons(localTree).some((b) => textOf(b).includes(t))))

  const feiyuTree = expand(renderAt('voice', { ...base, ttsProvider: 'feiyu' }))
  const feiyuKeys = shownKeys(feiyuTree)
  check('选肥鱼时显示肥鱼那套（feiyuBaseUrl / feiyuVoice）', feiyuKeys.has('feiyuBaseUrl') && feiyuKeys.has('feiyuVoice'))
  check(
    '选肥鱼时本地那套收起来',
    !feiyuKeys.has('ttsVoice') && !feiyuKeys.has('ttsModelDir'),
    [...feiyuKeys].filter((k) => k.startsWith('tts') && k !== 'ttsProvider').join(', '),
  )
  check('两套共用的 voiceMaxChars 都留着', feiyuKeys.has('voiceMaxChars') && localKeys.has('voiceMaxChars'))

  const sherpaTree = expand(renderAt('voice', { ...base, ttsProvider: 'sherpa' }))
  const sherpaKeys = shownKeys(sherpaTree)
  check('sherpa 归在本地那一套', sherpaKeys.has('ttsVoice') && !sherpaKeys.has('feiyuVoice'))
}

// ── 4. 左下角入口 ─────────────────────────────────────────────────────────
{
  renderCard(base)
  const footer = registry.find((r) => r.options.name === 'sidebar.footer.action')
  check('注册了 sidebar.footer.action（左下角 Settings 上面那个位置）', Boolean(footer))
  check(
    '入口 id / order 齐全',
    footer?.options?.id === 'qq-bridge-neko' && typeof footer?.options?.order === 'number',
    JSON.stringify(footer?.options),
  )

  if (footer) {
    // 未点开：就是一个按钮
    stateBuckets.delete(footer.cell.type)
    const closed = expand(footer.cell({ wide: true }))
    check('未点开时只是个按钮', closed?.type === 'button', String(closed?.type))
    check('按钮上有名字', textOf(closed).includes('QQ 桥接 Neko'), textOf(closed))

    // 点开：FootEntry 的第 0 个 state 是 open
    const entryFn = footer.cell.type
    const opened = (() => {
      const probe = footer.cell({ wide: true })
      const fn = probe.type
      // 先展开一次把 bucket 建出来，再置 true 重新渲染
      expand(probe)
      const bucket = stateBuckets.get(fn)
      if (bucket) bucket[0] = true
      return expand(footer.cell({ wide: true }))
    })()
    check('点开后是「按钮 + 浮层」两段', Array.isArray(opened?.children) ? opened.children.length >= 2 : opened?.type === 'fragment', String(opened?.type))
    const sheetKeys = shownKeys(opened)
    check('浮层里就是设置本体（字段真的渲染了）', sheetKeys.has('onebotUrl') || sheetKeys.has('ttsProvider'), [...sheetKeys].join(', '))
    check('浮层有关闭入口', buttons(opened).some((b) => textOf(b) === '关闭'))
    void entryFn
  }
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 条失败：`)
  for (const line of failures) console.error(`  - ${line}`)
  console.error(`\n通过 ${pass} 条\n`)
  process.exit(1)
}
console.log(`✓ 全部通过（${pass} 条）`)
