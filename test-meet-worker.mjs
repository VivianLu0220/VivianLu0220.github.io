// meet-worker.js 的测试（node test-meet-worker.mjs 运行，无依赖）
import assert from 'node:assert';
import worker, { parseIcsBusy } from './meet-worker.js';

// ── 内存 KV mock ──
function makeKV() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, val, _options) { store.set(key, val); },
    async list({ prefix } = {}) {
      return { keys: [...store.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })) };
    },
    _store: store,
  };
}

const ADMIN_KEY = 'secret123';
const env = { KV: makeKV(), ADMIN_KEY };

async function call(method, path, { body, admin, ip } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (admin) headers['X-Admin-Key'] = ADMIN_KEY;
  if (ip) headers['CF-Connecting-IP'] = ip;
  const res = await worker.fetch(new Request('https://x.test' + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  }), env);
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data };
}

let passed = 0;
const ok = label => { passed++; console.log('  PASS: ' + label); };

// ── 时段管理 ──
let r = await call('POST', '/admin/slots', { admin: true, body: { action: 'add', date: '2026-08-13', start: '10:00', end: '15:00' } });
assert.strictEqual(r.status, 200); ok('加时段成功');
r = await call('POST', '/admin/slots', { admin: true, body: { action: 'add', date: '2026-08-13', start: '14:00', end: '16:00' } });
assert.strictEqual(r.status, 409); ok('重叠时段 409');
r = await call('POST', '/admin/slots', { admin: true, body: { action: 'add', date: '2026-02-31', start: '10:00', end: '11:00' } });
assert.strictEqual(r.status, 400); ok('非法日期（2026-02-31）400');
r = await call('POST', '/admin/slots', { admin: true, body: { action: 'add', date: '2026-08-14', start: '15:00', end: '12:00' } });
assert.strictEqual(r.status, 400); ok('end<=start 400');

r = await call('GET', '/admin/state', { admin: true });
const slotA = r.data.slots[0];

// ── 邀请流程 ──
r = await call('POST', '/request', { ip: '1.1.1.1', body: { slotId: slotA.id, category: '吃的', event: '费大厨', name: 'Alice', wechat: 'a', message: 'hi' } });
assert.strictEqual(r.status, 200); ok('提交邀请成功');
r = await call('GET', '/state');
assert.strictEqual(r.data.slots[0].status, 'pending'); ok('/state 显示 pending');
r = await call('POST', '/request', { ip: '2.2.2.2', body: { slotId: slotA.id, event: 'x', name: 'Bob' } });
assert.strictEqual(r.status, 409); ok('同时段再提交 409');
r = await call('POST', '/request', { ip: '3.3.3.3', body: { slotId: slotA.id, event: 'x', name: 123 } });
assert.strictEqual(r.status, 400); ok('非字符串字段 400');
r = await call('POST', '/admin/slots', { admin: true, body: { action: 'delete', id: slotA.id } });
assert.strictEqual(r.status, 409); ok('删除有 pending 的时段 409');

// ── 确认 / 拒绝 ──
r = await call('GET', '/admin/state', { admin: true });
const reqA = r.data.requests.find(x => x.name === 'Alice');
r = await call('POST', '/admin/decide', { admin: true, body: { requestId: reqA.id, action: 'confirm' } });
assert.strictEqual(r.status, 200); ok('确认成功');
r = await call('GET', '/state');
assert.strictEqual(r.data.slots[0].status, 'confirmed'); ok('确认后 slot confirmed');
r = await call('POST', '/admin/decide', { admin: true, body: { requestId: reqA.id, action: 'confirm' } });
assert.strictEqual(r.status, 409); ok('重复处理同一邀请 409');

// 同 slot 迟到的 pending 不能再 confirm（防双重排期守卫）
const late = { id: 'late-1', slotId: slotA.id, category: '', event: 'x', name: 'C', wechat: '', message: '', status: 'pending', createdAt: new Date().toISOString() };
await env.KV.put('meet:req:late-1', JSON.stringify(late));
r = await call('POST', '/admin/decide', { admin: true, body: { requestId: 'late-1', action: 'confirm' } });
assert.strictEqual(r.status, 409); ok('已确认时段上再 confirm 409');

// ── 鉴权 ──
for (const [m, p] of [['GET', '/admin/state'], ['POST', '/admin/slots'], ['POST', '/admin/decide']]) {
  r = await call(m, p, m === 'POST' ? { body: {} } : {});
  assert.strictEqual(r.status, 401);
}
ok('三个 admin 路由未鉴权均 401');

// ── 每 IP 限流（每日 5 次）──
r = await call('POST', '/admin/slots', { admin: true, body: { action: 'add', date: '2026-08-15', start: '10:00', end: '20:00' } });
// 直接把该 IP 的当日计数置为 5，模拟已用完限额
const today = new Date().toISOString().slice(0, 10);
await env.KV.put(`meet:rl:9.9.9.9:${today}`, '5');
r = await call('GET', '/admin/state', { admin: true });
const freeSlot = r.data.slots.find(s => s.status === 'free');
r = await call('POST', '/request', { ip: '9.9.9.9', body: { slotId: freeSlot.id, event: 'x', name: 'Spam' } });
assert.strictEqual(r.status, 429); ok('同 IP 第 6 次提交 429');
r = await call('POST', '/request', { ip: '8.8.8.8', body: { slotId: freeSlot.id, event: 'x', name: 'Ok' } });
assert.strictEqual(r.status, 200); ok('换 IP 仍可提交');

// ── iCal 解析 ──
const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT', 'DTSTART:20260812T100000Z', 'DTEND:20260812T120000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;TZID=America/New_York:20260812T100000', 'DTEND;TZID=America/New_York:20260812T110000', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20260815', 'DTEND;VALUE=DATE:20260816', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART:20260816T100000Z', 'DTEND:20260816T110000Z', 'TRANSP:TRANSPARENT', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART:20260820T150000Z', 'DTEND:20260820T170000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART:20260824T040000Z', 'DTEND:20260824T050000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');
const busy = parseIcsBusy(ICS, new Date('2026-08-01T00:00:00Z'), new Date('2026-09-30T00:00:00Z'));
assert.deepStrictEqual(busy.filter(b => b.date === '2026-08-12'), [
  { date: '2026-08-12', start: '18:00', end: '20:00' },
  { date: '2026-08-12', start: '22:00', end: '23:00' },
]); ok('UTC 与 TZID 事件转上海时间');
assert.ok(!busy.some(b => b.date === '2026-08-15' || b.date === '2026-08-16')); ok('全天/空闲事件跳过');
assert.deepStrictEqual(busy.filter(b => b.date === '2026-08-20'), [{ date: '2026-08-20', start: '23:00', end: '24:00' }]);
assert.deepStrictEqual(busy.filter(b => b.date === '2026-08-21'), [{ date: '2026-08-21', start: '00:00', end: '01:00' }]);
ok('跨天事件按日切段');
assert.deepStrictEqual(busy.filter(b => b.start === '12:00').map(b => b.date), ['2026-08-24', '2026-08-31', '2026-09-07']);
ok('WEEKLY COUNT=3 展开');

// ── /busy 路由：固定窗口 + KV 缓存 ──
env.BUSY_FROM = '2026-08-11'; env.BUSY_TO = '2026-08-27';
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; return new Response([
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT', 'DTSTART:20260812T060000Z', 'DTEND:20260812T080000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART:20260905T060000Z', 'DTEND:20260905T080000Z', 'END:VEVENT',
  'END:VCALENDAR'].join('\r\n')); };
r = await call('GET', '/busy');
assert.deepStrictEqual(r.data, { busy: [] }); ok('未配置 ICAL_URL 时 /busy 为空');
env.ICAL_URL = 'https://example.com/x.ics';
r = await call('GET', '/busy');
assert.deepStrictEqual(r.data.busy, [{ date: '2026-08-12', start: '14:00', end: '16:00' }]); ok('固定窗口过滤窗外事件');
r = await call('GET', '/busy');
assert.strictEqual(fetchCalls, 1); ok('/busy 第二次命中 KV 缓存');

// ── /state 内存缓存：60s 内不重复 list，写操作后立刻失效 ──
let listCalls = 0;
const origList = env.KV.list.bind(env.KV);
env.KV.list = (...a) => { listCalls++; return origList(...a); };
r = await call('GET', '/state');
const afterMiss = listCalls;
assert.ok(afterMiss > 0);
r = await call('GET', '/state');
assert.strictEqual(listCalls, afterMiss); ok('60s 内重复 /state 命中内存缓存，不消耗 KV list');
r = await call('POST', '/admin/slots', { admin: true, body: { action: 'add', date: '2026-10-06', start: '10:00', end: '11:00' } });
assert.strictEqual(r.status, 200);
r = await call('GET', '/state');
assert.ok(listCalls > afterMiss);
assert.ok(r.data.slots.some(s => s.date === '2026-10-06'));
ok('写操作后缓存立刻失效，/state 返回最新数据');

console.log('\nALL ' + passed + ' ASSERTIONS PASSED');
