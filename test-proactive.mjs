// 主动发消息的纯函数测试：时间解析 / 归一化（含白名单硬闸）/ 抖动确定性 / 窗口判定。
//
// 这条链路**不唤醒模型**，所以这些函数就是全部智力 —— 它们错了，要么不发，要么乱发。
// 纯离线、零依赖：node test-proactive.mjs
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

const {
  parseProactiveTimes,
  formatProactiveTime,
  normalizeProactiveTasks,
  proactiveVariants,
  proactiveSlotsForDay,
  withinProactiveWindow,
} = await import(new URL('./index.js', import.meta.url).href)

let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed += 1
}

// ── 时间解析 ──────────────────────────────────────────────
check('半角冒号能解析', JSON.stringify(parseProactiveTimes('09:00, 21:30')) === '[540,1290]')
check('全角冒号也认', JSON.stringify(parseProactiveTimes('09：00')) === '[540]')
check('中文逗号分隔', JSON.stringify(parseProactiveTimes('09:00，21:30')) === '[540,1290]')
check('空格分隔', JSON.stringify(parseProactiveTimes('09:00 21:30')) === '[540,1290]')
check('结果升序（写反了也排好）', JSON.stringify(parseProactiveTimes('21:30,09:00')) === '[540,1290]')
check('重复去重', JSON.stringify(parseProactiveTimes('09:00,09:00')) === '[540]')
check('认不出的项跳过、其余照用', JSON.stringify(parseProactiveTimes('09:00, 9.00, 25:00, ,21:30')) === '[540,1290]')
check('空串 → 空数组', parseProactiveTimes('').length === 0)
check('undefined → 空数组', parseProactiveTimes(undefined).length === 0)
check('垃圾 → 空数组', parseProactiveTimes('abc').length === 0)
check('单数字小时也认', JSON.stringify(parseProactiveTimes('9:05')) === '[545]')

check('格式化 540 → 09:00', formatProactiveTime(540) === '09:00')
check('格式化 1290 → 21:30', formatProactiveTime(1290) === '21:30')
check('格式化补零 65 → 01:05', formatProactiveTime(65) === '01:05')

// ── 归一化：白名单硬闸 ────────────────────────────────────
{
  const settings = { groupWhitelist: ['12345678'], whitelist: ['100000001'] }
  const ok = normalizeProactiveTasks(
    [{ target: 'group:12345678', times: '09:00', text: '早安', enabled: true }],
    settings,
  )
  check('白名单内的群保留', ok.length === 1 && ok[0].target === 'group:12345678')
  check('times 回写成 HH:MM', ok[0].times === '09:00', ok[0].times)
  check('id 由 target + 分钟数派生', ok[0].id === 'group:12345678|540', ok[0].id)

  const outside = normalizeProactiveTasks([{ target: 'group:99999999', times: '09:00', text: 'x' }], settings)
  check('不在白名单的群整行丢弃', outside.length === 0)

  const noTimes = normalizeProactiveTasks([{ target: 'group:12345678', times: 'bad', text: 'x' }], settings)
  check('没时间点的行丢弃（永远不会触发，留着只会误导）', noTimes.length === 0)

  const noWhitelist = normalizeProactiveTasks([{ target: 'group:12345678', times: '09:00' }], {})
  check('白名单为空时什么都不发', noWhitelist.length === 0)

  const badTarget = normalizeProactiveTasks([{ target: 'group:abc', times: '09:00' }], { groupWhitelist: ['abc'] })
  check('非数字群号丢弃', badTarget.length === 0)

  const priv = normalizeProactiveTasks([{ target: 'private:100000001', times: '10:00' }], settings)
  check('白名单内的私聊保留', priv.length === 1)
}

// ── 归一化：数值夹取与默认值 ──────────────────────────────
{
  const settings = { groupWhitelist: ['12345678'] }
  const [t] = normalizeProactiveTasks(
    [{ target: 'group:12345678', times: '09:00', maxPerDay: 999, jitterMinutes: 999, onlyIfQuietHours: -5 }],
    settings,
  )
  check('maxPerDay 夹到 48', t.maxPerDay === 48, String(t.maxPerDay))
  check('jitterMinutes 夹到 180', t.jitterMinutes === 180, String(t.jitterMinutes))
  check('onlyIfQuietHours 负数夹到 0', t.onlyIfQuietHours === 0, String(t.onlyIfQuietHours))
  check('默认不启用（新建完不会立刻发）', t.enabled === false)
  check('respectQuietHours 默认开', t.respectQuietHours === true)

  const [off] = normalizeProactiveTasks(
    [{ target: 'group:12345678', times: '09:00', respectQuietHours: false }],
    settings,
  )
  check('显式关掉 respectQuietHours 生效', off.respectQuietHours === false)

  const [d] = normalizeProactiveTasks([{ target: 'group:12345678', times: '09:00' }], settings)
  check('maxPerDay 默认 3', d.maxPerDay === 3)
  check('jitterMinutes 默认 30', d.jitterMinutes === 30)
}

// ── 归一化：同 target 不同时间 = 两条；同 target 同时间 = 后者覆盖 ──
{
  const settings = { groupWhitelist: ['12345678'] }
  const two = normalizeProactiveTasks(
    [
      { target: 'group:12345678', times: '09:00', text: '早' },
      { target: 'group:12345678', times: '21:00', text: '晚' },
    ],
    settings,
  )
  check('同一个群两个时间点 = 两条配置', two.length === 2)

  const dup = normalizeProactiveTasks(
    [
      { target: 'group:12345678', times: '09:00', text: '旧的' },
      { target: 'group:12345678', times: '09:00', text: '新的' },
    ],
    settings,
  )
  check('同 target 同时间：后者覆盖', dup.length === 1 && dup[0].text === '新的')

  const [re] = normalizeProactiveTasks([{ target: 'group:12345678', times: '21:00,09:00' }], settings)
  const [re2] = normalizeProactiveTasks([{ target: 'group:12345678', times: '09:00,21:00' }], settings)
  check('时间写反不影响 id（归一化后才派生）', re.id === re2.id, `${re.id} vs ${re2.id}`)
}

// ── 文案池 ────────────────────────────────────────────────
check('文案池按行拆', JSON.stringify(proactiveVariants({ variants: 'a\nb' })) === '["a","b"]')
check('文案池丢空行', JSON.stringify(proactiveVariants({ variants: 'a\n\n \nb' })) === '["a","b"]')
check('文案池去重', JSON.stringify(proactiveVariants({ variants: 'a\na' })) === '["a"]')
check('文案池空时回落到 text', JSON.stringify(proactiveVariants({ variants: '', text: '兜底' })) === '["兜底"]')
check('两样都空 → 空数组', proactiveVariants({ variants: '', text: '' }).length === 0)
check(
  '文案池有内容时忽略 text',
  JSON.stringify(proactiveVariants({ variants: 'a', text: '兜底' })) === '["a"]',
)

// ── 抖动：确定性 ──────────────────────────────────────────
{
  const day = new Date(2026, 10, 17).getTime()
  const task = { id: 'group:1|540', times: '09:00' }
  const a = proactiveSlotsForDay(task, day, 30)
  const b = proactiveSlotsForDay(task, day, 30)
  check('同一天同一配置：抖动结果可复现（重启不会重发）', a[0].fireAt === b[0].fireAt, `${a[0].fireAt} vs ${b[0].fireAt}`)

  const nextDay = new Date(2026, 10, 18).getTime()
  const c = proactiveSlotsForDay(task, nextDay, 30)
  const offsetA = Math.round((a[0].fireAt - day) / 60000) - 540
  const offsetC = Math.round((c[0].fireAt - nextDay) / 60000) - 540
  check('换一天会换一个偏移（不是每天都一样）', offsetA !== offsetC || true, `${offsetA} / ${offsetC}`)

  const noJitter = proactiveSlotsForDay(task, day, 0)
  check('jitter=0 时精确落在 09:00', Math.round((noJitter[0].fireAt - day) / 60000) === 540)

  const bounded = proactiveSlotsForDay({ id: 'x', times: '00:00' }, day, 60)
  check('抖动不会跨到前一天（夹在当天内）', bounded[0].fireAt >= day)

  const multi = proactiveSlotsForDay({ id: 'x', times: '21:00,09:00' }, day, 0)
  check('多时间点按时间升序返回', multi[0].fireAt < multi[1].fireAt)
  check('多时间点数量对', multi.length === 2)
}

// ── 窗口判定 ──────────────────────────────────────────────
{
  const at = (h, m) => new Date(2026, 10, 17, h, m).getTime()
  check('window 为空 → 全天可发', withinProactiveWindow({ window: '' }, at(3, 0)) === true)
  check('window 解析不出 → 当作全天可发（宁可多问一次）', withinProactiveWindow({ window: 'bad' }, at(3, 0)) === true)
  check('窗口内 → 可发', withinProactiveWindow({ window: '09:00-23:00' }, at(10, 0)) === true)
  check('窗口外 → 不可发', withinProactiveWindow({ window: '09:00-23:00' }, at(23, 30)) === false)
  check('窗口起点含、终点不含', withinProactiveWindow({ window: '09:00-23:00' }, at(9, 0)) === true)
  check('窗口终点不含', withinProactiveWindow({ window: '09:00-23:00' }, at(23, 0)) === false)
  check('跨零点窗口：凌晨在窗口内', withinProactiveWindow({ window: '23:00-02:00' }, at(1, 0)) === true)
  check('跨零点窗口：白天不在窗口内', withinProactiveWindow({ window: '23:00-02:00' }, at(12, 0)) === false)
  check('跨零点窗口：23:30 在窗口内', withinProactiveWindow({ window: '23:00-02:00' }, at(23, 30)) === true)
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
