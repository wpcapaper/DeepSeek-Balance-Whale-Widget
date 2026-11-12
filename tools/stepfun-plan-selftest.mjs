// tools/stepfun-plan-selftest.mjs —— StepFun Plan 模板 / 令牌续期的自检（0 依赖，Node 直接跑）
//
// 用假 ctx + 假 fetch 驱动**真实的 lib/index.js**，不联网、不碰真实凭据与 DSH_HOME：
//   · 模板是否下发（kind:'quota' / 凭据名 / authRefresh）
//   · 额度请求的 POST、自定义请求头、{web_id} 占位符
//   · remainPctScale：0..1 剩余比例 → 百分比
//   · 接口报未认证 / HTTP 401 → 自动续期 + 回写凭据 + 重试一次
//   · JWT 临近过期 → 请求额度前先续期
//   · 缺 web_id 时不发该头、也不把 {web_id} 字面量发出去
//   · 「测试连通性」走额度接口
//
// 用法：node tools/stepfun-plan-selftest.mjs
//      PLUGIN_DIR=/path/to/lib/index.js node tools/stepfun-plan-selftest.mjs  # 测别的副本
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(process.env.PLUGIN_DIR || path.join(HERE, '..', 'lib', 'index.js'))
const HOST = '127.0.0.1:39123'
const TOKEN = 'access1.payload1.sig1...refresh1'
const HOSTS = {
  quota: 'https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit',
  refresh: 'https://platform.stepfun.com/passport/proto.api.passport.v1.PassportService/RefreshToken',
}

let failures = 0
function ok(cond, name, extra) {
  if (cond) { console.log('  ok  ' + name) }
  else { failures++; console.log('  FAIL ' + name + (extra ? ' → ' + extra : '')) }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-stepfun-'))
process.env.DSH_HOME = home

function writeRegistry(model) {
  fs.writeFileSync(path.join(home, '.dshw-api.json'), JSON.stringify({ version: 1, models: [model], usage: {} }))
}

function makeModel(extra) {
  return Object.assign({
    id: 'm_stepfun_plan', name: 'StepFun Plan', provider: 'stepfun_plan', currency: 'CNY',
    keyRef: 'STEPFUN_PLAN_OASIS_TOKEN', params: { web_id: 'webid123' }, createdAt: 1,
  }, extra || {})
}

function makeReq(body) {
  const chunks = body ? [Buffer.from(body)] : []
  return {
    method: body ? 'POST' : 'GET',
    headers: { host: HOST, 'content-type': 'application/json' },
    on(ev, fn) {
      if (ev === 'data') for (const c of chunks) fn(c)
      if (ev === 'end') fn()
      if (ev === 'error') { /* noop */ }
      return this
    },
    destroy() {},
  }
}
function makeRes() {
  return {
    statusCode: 0, body: '', writeHead(c) { this.statusCode = c }, end(b) { this.body = b ? String(b) : '' }, setHeader() {},
  }
}

async function setup({ token = TOKEN, registry, fetchImpl, credentials } = {}) {
  writeRegistry(registry || makeModel())
  const store = new Map()
  if (token !== null) store.set('STEPFUN_PLAN_OASIS_TOKEN', { value: token })
  if (credentials) for (const [k, v] of Object.entries(credentials)) store.set(k, { value: v })
  const sets = []
  const routes = []
  const ctx = {
    credentials: {
      resolve: async (ref) => (store.has(ref) ? { value: store.get(ref).value } : null),
      set: async (ref, val) => { sets.push([ref, val]); store.set(ref, { value: val }) },
      unset: async () => {},
    },
    webServer: { register: (route) => { routes.push(route); return () => {} }, tapIndex: () => (() => {}) },
    get: () => null,
    connection: null,
    on: () => () => {},
    effect: () => () => {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
  const root = {
    on: () => () => {},
    effect: () => () => {},
    inject: (services, cb) => { cb(ctx); return () => {} },
  }
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} })
    return fetchImpl(String(url), init || {})
  }
  const mod = await import(pathToFileURL(PLUGIN).href + '?t=' + Math.random())
  mod.default.apply(root)
  const route = routes.find((r) => r.path === '/dsh-whale/api-models.json')
  if (!route) throw new Error('api-models route 未注册')
  return { ctx, sets, calls, store, routes, route }
}

async function callModels(route, body) {
  const res = makeRes()
  await route.handler(makeReq(body), res)
  return { status: res.statusCode, json: JSON.parse(res.body || '{}') }
}

function quotaCalls(calls) { return calls.filter((c) => c.url === HOSTS.quota) }
function refreshCalls(calls) { return calls.filter((c) => c.url === HOSTS.refresh) }
function jsonResp(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
}
function stepfunPayload(left) {
  return jsonResp({
    code: 'ok',
    data: { planCreditRateLimit: { subscriptionCreditLeftRate: left, subscriptionCreditResetTime: Math.floor(Date.now() / 1000) + 86400 } },
  })
}
function expiredResp() { return jsonResp({ code: 'unauthenticated', message: 'access token expired' }) }
function refreshResp() { return jsonResp({ accessToken: { raw: 'access2' }, refreshToken: { raw: 'refresh2' } }) }

// ---------------------------------------------------------------------------
console.log('\n[1] 模板出现在 /api-models.json 里，且是 kind=quota（前端据此显示「厂商额度」）')
{
  const { route, calls } = await setup({ fetchImpl: () => stepfunPayload(0.875) })
  const { status, json } = await callModels(route)
  ok(status === 200, 'HTTP 200', String(status))
  const tpl = (json.templates || []).find((t) => t.id === 'stepfun_plan')
  ok(!!tpl, '模板 stepfun_plan 已下发')
  if (tpl) {
    ok(tpl.kind === 'quota', 'kind=quota', tpl.kind)
    ok(tpl.keyRef === 'STEPFUN_PLAN_OASIS_TOKEN', '默认凭据名正确', tpl.keyRef)
    ok(!!(tpl.quota && tpl.quota.authRefresh), '带 authRefresh 配置')
  }
  ok(quotaCalls(calls).length === 1, '列表请求顺带拉了一次额度（plan 行需要实时数据）')
}

console.log('\n[2] 额度请求：POST + 三个自定义头 + {web_id} 占位符 + 剩余 0.875 → 已用 12.5%')
{
  const { route, calls } = await setup({ fetchImpl: () => stepfunPayload(0.875) })
  const { json } = await callModels(route)
  const entry = (json.models || []).find((m) => m.id === 'm_stepfun_plan')
  ok(!!entry, '模型出现在 models 里')
  ok(entry && entry.planSupport === true, 'planSupport=true')
  ok(entry && entry.plan && entry.plan.ok === true, 'plan.ok', JSON.stringify(entry && entry.plan))
  ok(entry && entry.plan && Math.abs(entry.plan.usedPct - 12.5) < 1e-9, 'usedPct=12.5（leftRate=0.875 是剩余比例）', String(entry && entry.plan && entry.plan.usedPct))
  ok(entry && entry.plan && entry.plan.remainPct === 87.5, 'remainPct=87.5', String(entry && entry.plan && entry.plan.remainPct))
  ok(entry && entry.plan && entry.plan.resetAt > 0, 'resetAt 有值', String(entry && entry.plan && entry.plan.resetAt))
  const q = quotaCalls(calls)[0]
  ok(!!q, '发出了额度请求')
  if (q) {
    ok(String(q.init.method || '').toUpperCase() === 'POST', 'method=POST', q.init.method)
    ok(q.init.body === '{}', 'body={}', q.init.body)
    const h = q.init.headers || {}
    ok(h['Oasis-Token'] === TOKEN, 'Oasis-Token = 凭据值')
    ok(h['Oasis-Webid'] === 'webid123', 'Oasis-Webid = params.web_id', h['Oasis-Webid'])
    ok(h['Oasis-appID'] === '10300', 'Oasis-appID=10300', h['Oasis-appID'])
    ok(h['Oasis-Platform'] === 'web', 'Oasis-Platform=web', h['Oasis-Platform'])
    ok(!JSON.stringify(h).includes('{web_id}'), '没有把 {web_id} 字面量发出去')
  }
  ok(refreshCalls(calls).length === 0, '令牌未过期 → 不调续期接口')
}

console.log('\n[3] 接口报 unauthenticated（HTTP 200）→ 自动续期 + 回写凭据 + 重试一次')
{
  let quotaHits = 0
  const { route, calls, sets, store } = await setup({
    fetchImpl: (url) => {
      if (url === HOSTS.refresh) return refreshResp()
      quotaHits++
      return quotaHits === 1 ? expiredResp() : stepfunPayload(0.5)
    },
  })
  const { json } = await callModels(route)
  const entry = (json.models || []).find((m) => m.id === 'm_stepfun_plan')
  ok(entry && entry.plan && entry.plan.ok === true, '重试后 plan.ok')
  ok(entry && Math.abs(entry.plan.usedPct - 50) < 1e-9, '重试后 usedPct=50', String(entry && entry.plan && entry.plan.usedPct))
  ok(refreshCalls(calls).length === 1, '续期接口调用 1 次', String(refreshCalls(calls).length))
  ok(sets.length === 1 && sets[0][0] === 'STEPFUN_PLAN_OASIS_TOKEN', '回写凭据键名正确', JSON.stringify(sets))
  ok(sets.length === 1 && sets[0][1] === 'access2...refresh2', '回写的是 access...refresh 组合串', JSON.stringify(sets))
  ok(store.get('STEPFUN_PLAN_OASIS_TOKEN').value === 'access2...refresh2', '凭据已更新')
  const second = quotaCalls(calls)[1]
  ok(!!second && (second.init.headers || {})['Oasis-Token'] === 'access2...refresh2', '重试请求用的是新令牌')
}

console.log('\n[4] 访问令牌 JWT 已过期 → 请求额度前先续期（不浪费一次 401）')
{
  const expiredJwt = 'h.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 120 })).toString('base64url') + '.s'
  const { route, calls } = await setup({
    token: expiredJwt + '...refresh0',
    fetchImpl: (url) => (url === HOSTS.refresh ? refreshResp() : stepfunPayload(0.25)),
  })
  const { json } = await callModels(route)
  const entry = (json.models || []).find((m) => m.id === 'm_stepfun_plan')
  ok(entry && entry.plan && entry.plan.ok === true, 'plan.ok')
  ok(refreshCalls(calls).length === 1, '先续期 1 次', String(refreshCalls(calls).length))
  const firstIdx = calls.findIndex((c) => c.url === HOSTS.quota)
  const refreshIdx = calls.findIndex((c) => c.url === HOSTS.refresh)
  ok(refreshIdx >= 0 && firstIdx > refreshIdx, '续期发生在额度请求之前', `refresh@${refreshIdx} quota@${firstIdx}`)
  const qc = quotaCalls(calls)[0]
  ok(!!qc && (qc.init.headers || {})['Oasis-Token'] === 'access2...refresh2', '额度请求用新令牌')
  ok(Math.abs(entry.plan.usedPct - 75) < 1e-9, 'usedPct=75', String(entry.plan.usedPct))
}

console.log('\n[5] 没填 web_id：不发 Oasis-Webid 头，也不发字面量；接口 401 时尝试续期后优雅失败')
{
  const { route, calls } = await setup({
    registry: makeModel({ params: {} }),
    fetchImpl: () => jsonResp({ code: 'unauthorized', message: 'missing webid' }, 401),
  })
  const { status, json } = await callModels(route)
  ok(status === 200, '列表仍返回 200')
  const entry = (json.models || []).find((m) => m.id === 'm_stepfun_plan')
  ok(entry && entry.plan && entry.plan.ok === false, 'plan.ok=false（不崩）', JSON.stringify(entry && entry.plan))
  const q = quotaCalls(calls)[0]
  ok(!!q, '仍发出额度请求（由服务端判定缺凭据）')
  if (q) {
    ok(!('Oasis-Webid' in (q.init.headers || {})), 'Oasis-Webid 头被跳过')
    ok(!JSON.stringify(q.init.headers || {}).includes('{web_id}'), '没有字面量 {web_id}')
  }
  ok(refreshCalls(calls).length === 1, '401 也会尝试一次续期（续期返回 401 时放弃，不死循环）')
}

console.log('\n[6] 「测试连通性」对只有额度接口的模板走额度探头')
{
  const { route } = await setup({ fetchImpl: () => stepfunPayload(0.4) })
  const { json } = await callModels(route, JSON.stringify({ action: 'probe', id: 'm_stepfun_plan' }))
  ok(json.ok === true, 'probe ok=true', JSON.stringify(json))
  ok(String(json.detail || '').includes('额度接口'), 'detail 说明是额度接口', String(json.detail))
  ok(String(json.detail || '').includes('60%'), 'detail 带已用百分比 60%', String(json.detail))
}

console.log('\n[7] 没有凭据时：不请求、不报错栈，plan 不出现')
{
  const { route, calls } = await setup({ token: null, fetchImpl: () => stepfunPayload(0.1) })
  const { json } = await callModels(route)
  const entry = (json.models || []).find((m) => m.id === 'm_stepfun_plan')
  ok(entry && entry.hasKey === false, 'hasKey=false')
  ok(entry && !entry.plan, '没有发起额度请求')
  ok(calls.filter((c) => c.url.startsWith('https://platform.stepfun.com')).length === 0, '没有网络请求发给 StepFun')
}

fs.rmSync(home, { recursive: true, force: true })
console.log('\n' + (failures ? ('FAILED: ' + failures + ' 项') : 'ALL PASS'))
process.exit(failures ? 1 : 0)
