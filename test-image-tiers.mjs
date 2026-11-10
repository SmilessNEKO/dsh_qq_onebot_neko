// 图片识图分级单测：单张分级 / 本轮总量预算 / 占位符降级。
// 纯离线，零依赖。运行：node test-image-tiers.mjs
//
// 覆盖 classifyImageForDescribe / planImageBudget / inlineImageNotes 三个纯函数。
// 插件顶层 import 的 peer 依赖只在 DSH 宿主里（或宿主 node_modules 的软链里），
// 纯函数测试用 registerHooks 把它们重定向到内联 data: stub（不改插件、不写 node_modules）。
//
// 为什么 schemastery 也要 stub：index.js 顶层 `import Schema from '@deepseek-ai/schemastery'`
// 并用它构造设置 Schema。纯函数不碰 Schema，但模块求值必须先过这一关。
// stub 只需提供链式构造器的最小形状：每个方法都返回自身。
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const SCHEMA_STUB =
  'data:text/javascript,const chain=new Proxy(function(){},{get:()=>chain,apply:()=>chain});export default chain'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/schemastery') {
      return { url: SCHEMA_STUB, shortCircuit: true }
    }
    if (specifier === '@deepseek-ai/dsh-llm') {
      return { url: 'data:text/javascript,export const createUserMessage=(x)=>x', shortCircuit: true }
    }
    if (specifier === '@deepseek-ai/dsh-tools') {
      return { url: 'data:text/javascript,export const defineTool=(x)=>x', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const mod = await import(new URL('./index.js', import.meta.url).href)
const { classifyImageForDescribe, planImageBudget, inlineImageNotes } = mod

let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed += 1
}

const KB = 1024
const MB = 1024 * 1024

// ── 单张分级 ─────────────────────────────────────────────────
check('小图直接识图', classifyImageForDescribe(300 * KB).action === 'describe')
check('恰好等于安全阈值仍直接识图', classifyImageForDescribe(1572864).action === 'describe')
check('略超安全阈值改为压缩', classifyImageForDescribe(1572865).action === 'compress')
check('6MB 仍走压缩', classifyImageForDescribe(6 * MB).action === 'compress')
check('超过 6MB 默认不识别', classifyImageForDescribe(6 * MB + 1).action === 'skip')
check('超大图（50MB）不识别', classifyImageForDescribe(50 * MB).action === 'skip')
check('取不到大小时不崩且跳过', classifyImageForDescribe(undefined).action === 'skip')
check('大小为 0 时不崩且跳过', classifyImageForDescribe(0).action === 'skip')
check('NaN 时不崩且跳过', classifyImageForDescribe(Number.NaN).action === 'skip')
check(
  '阈值可被设置覆盖',
  classifyImageForDescribe(2 * MB, { safeBytes: 1 * MB, maxBytes: 3 * MB }).action === 'compress',
)

// ── 本轮总量预算 ─────────────────────────────────────────────
{
  const plan = planImageBudget([{ bytes: 1 * MB }, { bytes: 1 * MB }, { bytes: 1 * MB }], { totalBytes: 2.5 * MB })
  check('总量超预算的最后一张降级', JSON.stringify(plan.map((p) => p.action)) === JSON.stringify(['describe', 'describe', 'skip']))
}
{
  // 第二张走压缩，按目标字节估算，不该把第一张的小图挤掉
  const plan = planImageBudget([{ bytes: 500 * KB }, { bytes: 5 * MB }], { totalBytes: 2 * MB })
  check('压缩项按目标字节计入预算', plan[0].action === 'describe' && plan[1].action === 'compress')
}
{
  // 单张超标不占额度，后面的小图照常识图
  const plan = planImageBudget([{ bytes: 9 * MB }, { bytes: 100 * KB }], { totalBytes: 1 * MB })
  check('单张超标不占总量额度', plan[0].action === 'skip' && plan[1].action === 'describe')
}
{
  const plan = planImageBudget([], {})
  check('空列表返回空计划', Array.isArray(plan) && plan.length === 0)
}

// ── 占位符：跳过识图时不留裸冒号 ───────────────────────────────
{
  const a = { hash: 'ae2d431122334455' }
  const notes = new Map([[a, { text: '', hash: a.hash }]])
  check(
    '跳过识图只留位置标记',
    inlineImageNotes('[图片] 文字', [a], notes) === '[图片#ae2d43] 文字',
  )
}
{
  const face = { hash: 'c53f48832cf83a7c', mface: { emoji_id: '1', emoji_package_id: 2, key: 'k', summary: '[确实]' } }
  const notes = new Map([[face, { text: '', hash: face.hash }]])
  check(
    '商城表情关掉描述仍保留表情名',
    inlineImageNotes('[图片] 看图', [face], notes) === '[表情包#c53f48]：[确实] 看图',
  )
}
{
  const a = { hash: 'ae2d431122334455' }
  const notes = new Map([[a, { text: '蓝发女仆捧空碗', hash: a.hash }]])
  check(
    '有描述时行为不变',
    inlineImageNotes('[图片] 配文', [a], notes) === '[图片#ae2d43]：蓝发女仆捧空碗 配文',
  )
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
