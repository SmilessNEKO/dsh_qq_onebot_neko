// 会话轮换单测：按轮数 / 按上下文压力 / 阈值边界 / 缺值不误判。
// 纯离线，零依赖。运行：node test-session-rotate.mjs
//
// peer 依赖 stub 同 test-image-tiers.mjs：这些包只在 DSH 宿主里，
// 纯函数测试用 registerHooks 重定向到内联 data: stub。
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const SCHEMA_STUB =
  'data:text/javascript,const chain=new Proxy(function(){},{get:()=>chain,apply:()=>chain});export default chain'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/schemastery') return { url: SCHEMA_STUB, shortCircuit: true }
    if (specifier === '@deepseek-ai/dsh-llm') {
      return { url: 'data:text/javascript,export const createUserMessage=(x)=>x', shortCircuit: true }
    }
    if (specifier === '@deepseek-ai/dsh-tools') {
      return { url: 'data:text/javascript,export const defineTool=(x)=>x', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const { rotateSessionVerdict } = await import(
  new URL('./index.js', import.meta.url).href
)

let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed += 1
}

// ── 按轮数 ───────────────────────────────────────────────
check('轮数未到不轮换', rotateSessionVerdict({ turns: 10 }, { maxTurns: 300 }).rotate === false)
check('轮数刚到就轮换', rotateSessionVerdict({ turns: 300 }, { maxTurns: 300 }).rotate === true)
check('轮数超上限轮换', rotateSessionVerdict({ turns: 301 }, { maxTurns: 300 }).rotate === true)
check('maxTurns 为 0 时该项不生效', rotateSessionVerdict({ turns: 9999 }, { maxTurns: 0 }).rotate === false)

// ── 按上下文压力 ─────────────────────────────────────────
check(
  '压力未到阈值不轮换',
  rotateSessionVerdict({ pressureTokens: 700, contextWindow: 1000 }, { pressureRatio: 0.75 }).rotate === false,
)
check(
  '压力刚到阈值就轮换',
  rotateSessionVerdict({ pressureTokens: 750, contextWindow: 1000 }, { pressureRatio: 0.75 }).rotate === true,
)
check(
  '压力超阈值轮换',
  rotateSessionVerdict({ pressureTokens: 900, contextWindow: 1000 }, { pressureRatio: 0.75 }).rotate === true,
)
check(
  'pressureRatio 为 0 时该项不生效',
  rotateSessionVerdict({ pressureTokens: 999, contextWindow: 1000 }, { pressureRatio: 0 }).rotate === false,
)

// ── 两项取其一 ───────────────────────────────────────────
check(
  '轮数没到但压力到了 → 轮换',
  rotateSessionVerdict({ turns: 10, pressureTokens: 800, contextWindow: 1000 }, { maxTurns: 300, pressureRatio: 0.75 }).rotate === true,
)

// ── 缺值 / 脏值绝不能被误判成"该轮换" ──────────────────────
check('全空对象不轮换', rotateSessionVerdict({}, {}).rotate === false)
check('undefined 不轮换', rotateSessionVerdict(undefined, undefined).rotate === false)
check('轮数 NaN 不轮换', rotateSessionVerdict({ turns: Number.NaN }, { maxTurns: 300 }).rotate === false)
check('contextWindow 为 0 不除零', rotateSessionVerdict({ pressureTokens: 100, contextWindow: 0 }, { pressureRatio: 0.75 }).rotate === false)
check('压力缺 contextWindow 时不误判', rotateSessionVerdict({ pressureTokens: 999 }, { pressureRatio: 0.75 }).rotate === false)
check(
  '阈值全为 0 时永不轮换',
  rotateSessionVerdict({ turns: 9999, pressureTokens: 9999, contextWindow: 1 }, { maxTurns: 0, pressureRatio: 0 }).rotate === false,
)

// ── 原因文案 ─────────────────────────────────────────────
{
  const r = rotateSessionVerdict({ turns: 300 }, { maxTurns: 300 })
  check('轮数触发时带原因', typeof r.reason === 'string' && r.reason.length > 0, r.reason)
}
{
  const r = rotateSessionVerdict({ pressureTokens: 800, contextWindow: 1000 }, { pressureRatio: 0.75 })
  check('压力触发时带原因', typeof r.reason === 'string' && r.reason.includes('%'), r.reason)
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

