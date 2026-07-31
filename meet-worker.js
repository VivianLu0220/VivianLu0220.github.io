/**
 * Cloudflare Worker — 约饭 Scheduling Backend
 *
 * 部署步骤：
 * 1. 打开 https://dash.cloudflare.com → Workers & Pages → Create Worker
 * 2. 给 Worker 起名，比如 "ljw-meet"（也可以直接加到现有的 ljw-chat Worker 里，但建议分开）
 * 3. 把这个文件的内容粘贴进去，点 Deploy
 * 4. 在 Worker Settings → Variables and Secrets 里添加：
 *    - ADMIN_KEY = 你自己设一个管理密码（类型选 Secret），确认/管理时段要用
 *    - ICAL_URL  = Google Calendar 的 Secret iCal 地址（类型选 Secret，可选）。
 *      设置后 /busy 会返回未来 60 天的忙碌时间段（无事件详情），页面渲染成灰色块。
 *      获取方式：Google Calendar 设置 → 我的日历 → 该日历 → 「iCal 格式的私密地址」
 * 5. 在 Worker Settings → Bindings 里添加 KV：
 *    - Variable name: KV
 *    - KV namespace: 可以复用 chat 那个 KV（本 Worker 的 key 都带 meet: 前缀，不会冲突）
 * 6. 记下 Worker URL（如 https://ljw-meet.xxx.workers.dev）
 * 7. 把 meet.html 里的 API_URL 替换成这个 URL
 *
 * 数据模型（存 KV）：
 * - meet:slots        = [{id, date:"2026-08-12", start:"18:00", end:"21:00"}]
 *   单个 JSON 数组，只存时段本身、不存 status。只有管理员（单人）写它，无并发问题。
 * - meet:req:<uuid>   = {id, slotId, category, event, name, wechat, message,
 *                        status:"pending|confirmed|rejected", createdAt}
 *   每条邀请一个独立 KV key。每次提交写自己的 key，永不覆盖别人（解决并发丢数据）。
 *   读取全部邀请用 env.KV.list({prefix:'meet:req:'}) 再逐条 get。
 *
 * slot 的 status 不再落库，而是从邀请推导（computeStatus）：
 * - 该 slot 有 confirmed 邀请 → confirmed
 * - 否则有 pending 邀请       → pending
 * - 否则                      → free
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
};

const REQ_PREFIX = 'meet:req:';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function getList(env, key) {
  const raw = await env.KV.get(key);
  return raw ? JSON.parse(raw) : [];
}

async function putList(env, key, list) {
  await env.KV.put(key, JSON.stringify(list));
}

// 读取全部独立存储的邀请（meet:req:<uuid>）。规模只有几十条，直接并行拉取。
async function getAllRequests(env) {
  const listed = await env.KV.list({ prefix: REQ_PREFIX });
  const raws = await Promise.all(listed.keys.map(k => env.KV.get(k.name)));
  return raws.filter(Boolean).map(raw => JSON.parse(raw));
}

// 从邀请集合推导某个 slot 的状态：confirmed > pending > free。
function computeStatus(slotId, requests) {
  const forSlot = requests.filter(r => r.slotId === slotId);
  if (forSlot.some(r => r.status === 'confirmed')) return 'confirmed';
  if (forSlot.some(r => r.status === 'pending')) return 'pending';
  return 'free';
}

// ══════════ Google Calendar 忙碌时段（iCal Secret 地址，无需 OAuth）══════════
// 只输出 {date, start, end} 时间段，不含事件标题等任何详情。
const BUSY_CACHE_KEY = 'meet:busy-cache';
const BUSY_CACHE_TTL = 900; // 15 分钟：日历改动最多滞后这么久
const BUSY_WINDOW_DAYS = 60;

// iCal 折行还原（RFC 5545：续行以空格/Tab 开头）
function unfoldIcs(text) {
  return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

// 把某时区的本地时间转成绝对时间（迭代两次修正偏移；上海无夏令时，一次就准）
function zonedToUtc(y, mo, d, h, mi, s, tz) {
  let ts = Date.UTC(y, mo - 1, d, h, mi, s);
  for (let i = 0; i < 2; i++) {
    const p = new Date(ts).toLocaleString('sv-SE', { timeZone: tz, hour12: false });
    const [dp, tp] = p.split(' ');
    const [Y, M, D] = dp.split('-').map(Number);
    const [H, Mi, S] = tp.split(':').map(Number);
    ts += Date.UTC(y, mo - 1, d, h, mi, s) - Date.UTC(Y, M - 1, D, H, Mi, S);
  }
  return new Date(ts);
}

// 绝对时间 → 上海时区的 {date:'YYYY-MM-DD', time:'HH:mm'}
function toShanghai(dt) {
  const p = dt.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false });
  const [date, time] = p.split(' ');
  return { date, time: time.slice(0, 5) };
}

// 解析 iCal 日期值。全天事件（VALUE=DATE）返回 null——生日/纪念日不算忙碌。
// 无 Z 且无 TZID 的浮动时间按上海时间处理。
function parseIcsDate(value, params) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z === 'Z') return new Date(Date.UTC(+y, mo - 1, +d, +h, +mi, +s));
  return zonedToUtc(+y, +mo, +d, +h, +mi, +s, params.TZID || 'Asia/Shanghai');
}

// 展开重复事件的各次开始时间。支持 DAILY/WEEKLY（INTERVAL/UNTIL/COUNT/BYDAY 近似，
// 固定毫秒步进、忽略非上海时区的夏令时切换）；其他 FREQ 只取首次。
function expandStarts(ev, winEnd) {
  if (!ev.rrule) return [ev.start];
  const rule = Object.fromEntries(ev.rrule.split(';').map(p => p.split('=')));
  const freq = rule.FREQ;
  if (freq !== 'DAILY' && freq !== 'WEEKLY') return [ev.start];
  const interval = Math.max(1, +(rule.INTERVAL || 1) || 1);
  const until = rule.UNTIL ? parseIcsDate(rule.UNTIL, {}) : null;
  const count = rule.COUNT ? +rule.COUNT : null;

  const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const startMs = ev.start.getTime();
  let offsets = [0];
  if (freq === 'WEEKLY' && rule.BYDAY) {
    const startDow = new Date(toShanghai(ev.start).date + 'T00:00:00Z').getUTCDay();
    offsets = rule.BYDAY.split(',')
      .map(c => DAYS.indexOf(c.replace(/^[+-]?\d+/, '')))
      .filter(i => i >= 0)
      .map(i => (i - startDow + 7) % 7)
      .sort((a, b) => a - b);
    if (!offsets.length) offsets = [0];
  }
  const stepMs = (freq === 'DAILY' ? 1 : 7) * 86400000 * interval;
  const out = [];
  let produced = 0;
  for (let i = 0; i < 500; i++) {
    const base = startMs + i * stepMs;
    if (base > winEnd.getTime() + 8 * 86400000) break;
    for (const off of offsets) {
      const t = base + off * 86400000;
      if (t < startMs) continue;
      if (until && t > until.getTime()) continue;
      produced++;
      if (count && produced > count) return out;
      out.push(new Date(t));
      if (out.length >= 500) return out;
    }
  }
  return out;
}

// iCal 文本 → 窗口内的忙碌段 [{date,start,end}]（上海时区，跨天切段，同日合并重叠）
export function parseIcsBusy(text, winStart, winEnd) {
  const events = [];
  let cur = null;
  for (const line of unfoldIcs(text)) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const [prop, ...paramParts] = line.slice(0, idx).split(';');
    const params = {};
    for (const pp of paramParts) { const [k, v] = pp.split('='); params[k] = v; }
    const value = line.slice(idx + 1);
    if (prop === 'DTSTART') { cur.start = parseIcsDate(value, params); cur.allDay = params.VALUE === 'DATE' || /^\d{8}$/.test(value); }
    else if (prop === 'DTEND') cur.end = parseIcsDate(value, params);
    else if (prop === 'RRULE') cur.rrule = value;
    else if (prop === 'EXDATE') (cur.exdates ||= []).push(...value.split(',').map(v => parseIcsDate(v, params)).filter(Boolean));
    else if (prop === 'STATUS') cur.status = value;
    else if (prop === 'TRANSP') cur.transp = value;
  }

  const intervals = [];
  for (const ev of events) {
    if (!ev.start || !ev.end || ev.allDay) continue;
    if (ev.status === 'CANCELLED' || ev.transp === 'TRANSPARENT') continue;
    const dur = ev.end - ev.start;
    if (dur <= 0) continue;
    for (const st of expandStarts(ev, winEnd)) {
      if (ev.exdates && ev.exdates.some(x => Math.abs(x - st) < 1000)) continue;
      const en = new Date(st.getTime() + dur);
      if (en <= winStart || st >= winEnd) continue;
      intervals.push([st, en]);
    }
  }

  // 跨天切段（按上海时区的自然日）
  const byDate = {};
  for (const [st, en] of intervals) {
    let cursor = st;
    while (cursor < en) {
      const { date, time } = toShanghai(cursor);
      const [y, m, d] = date.split('-').map(Number);
      const dayEnd = zonedToUtc(y, m, d, 24, 0, 0, 'Asia/Shanghai');
      const segEnd = en < dayEnd ? en : dayEnd;
      const endTime = segEnd.getTime() === dayEnd.getTime() ? '24:00' : toShanghai(segEnd).time;
      if (time !== endTime) (byDate[date] ||= []).push([time, endTime]);
      cursor = dayEnd;
    }
  }

  // 同日合并重叠/相邻
  const busy = [];
  for (const date of Object.keys(byDate).sort()) {
    const segs = byDate[date].sort((a, b) => a[0].localeCompare(b[0]));
    const merged = [];
    for (const [s, e] of segs) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) { if (e > last[1]) last[1] = e; }
      else merged.push([s, e]);
    }
    for (const [s, e] of merged) busy.push({ date, start: s, end: e });
  }
  return busy;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const isAdmin = request.headers.get('X-Admin-Key') === env.ADMIN_KEY;

    try {
      // ── 公开：查看时段（不暴露预约人信息）──
      if (path === '/state' && request.method === 'GET') {
        const slots = await getList(env, 'meet:slots');
        const requests = await getAllRequests(env);
        return json({
          slots: slots.map(({ id, date, start, end }) => ({
            id, date, start, end, status: computeStatus(id, requests),
          })),
        });
      }

      // ── 公开：日历忙碌时段（只有时间段，无事件详情；KV 缓存 15 分钟）──
      if (path === '/busy' && request.method === 'GET') {
        if (!env.ICAL_URL) return json({ busy: [] });
        const cached = await env.KV.get(BUSY_CACHE_KEY);
        if (cached) return json(JSON.parse(cached));
        let busy = [];
        try {
          const res = await fetch(env.ICAL_URL);
          if (res.ok) {
            // 窗口：配置了 BUSY_FROM/BUSY_TO（YYYY-MM-DD，上海时区，含首尾）就用固定区间，
            // 否则默认今天起 60 天
            let winStart, winEnd;
            if (env.BUSY_FROM && env.BUSY_TO) {
              const [fy, fm, fd] = env.BUSY_FROM.split('-').map(Number);
              const [ty, tm, td] = env.BUSY_TO.split('-').map(Number);
              winStart = zonedToUtc(fy, fm, fd, 0, 0, 0, 'Asia/Shanghai');
              winEnd = zonedToUtc(ty, tm, td, 24, 0, 0, 'Asia/Shanghai');
            } else {
              winStart = new Date(Date.now() - 86400000);
              winEnd = new Date(Date.now() + BUSY_WINDOW_DAYS * 86400000);
            }
            busy = parseIcsBusy(await res.text(), winStart, winEnd);
            // 跨窗口边界的长事件会产生窗外日期的段，最后按日期再过滤一次
            if (env.BUSY_FROM && env.BUSY_TO) {
              busy = busy.filter(b => b.date >= env.BUSY_FROM && b.date <= env.BUSY_TO);
            }
          }
        } catch (e) {
          console.error(e); // 日历拉取失败不影响约饭主流程
        }
        const payload = { busy };
        await env.KV.put(BUSY_CACHE_KEY, JSON.stringify(payload), { expirationTtl: BUSY_CACHE_TTL });
        return json(payload);
      }

      // ── 公开：朋友提交邀请 ──
      if (path === '/request' && request.method === 'POST') {
        const body = await request.json();
        const { slotId, category, event, name, wechat, message } = body;
        if (!slotId || !event || !name) {
          return json({ error: '缺少必填字段' }, 400);
        }
        if (typeof slotId !== 'string' || typeof event !== 'string' || typeof name !== 'string') {
          return json({ error: '字段类型错误' }, 400);
        }
        if ((category !== undefined && typeof category !== 'string') ||
            (wechat !== undefined && typeof wechat !== 'string') ||
            (message !== undefined && typeof message !== 'string')) {
          return json({ error: '字段类型错误' }, 400);
        }
        if (name.length > 50 || event.length > 50 ||
            String(wechat || '').length > 50 || String(message || '').length > 300 ||
            String(category || '').length > 50) {
          return json({ error: '内容太长了' }, 400);
        }

        // 防滥用 1：每 IP 每日限额（尽力而为，非原子）
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rlKey = `meet:rl:${ip}:${new Date().toISOString().slice(0, 10)}`;
        const rlCount = parseInt(await env.KV.get(rlKey), 10) || 0;
        if (rlCount >= 5) {
          return json({ error: '今天提交太多次啦，明天再来～' }, 429);
        }

        // 防滥用 2：全局 pending 上限
        const requests = await getAllRequests(env);
        if (requests.filter(r => r.status === 'pending').length >= 20) {
          return json({ error: '待确认的邀请太多啦，等等再来～' }, 429);
        }

        const slots = await getList(env, 'meet:slots');
        const slot = slots.find(s => s.id === slotId);
        if (!slot) return json({ error: '这个时段不存在' }, 404);

        if (computeStatus(slotId, requests) !== 'free') {
          return json({ error: '这个时段刚被别人约走了，换一个吧' }, 409);
        }

        await env.KV.put(rlKey, String(rlCount + 1), { expirationTtl: 86400 });

        const id = crypto.randomUUID();
        await env.KV.put(REQ_PREFIX + id, JSON.stringify({
          id,
          slotId,
          category: String(category || ''),
          event: String(event),
          name: String(name),
          wechat: String(wechat || ''),
          message: String(message || ''),
          status: 'pending',
          createdAt: new Date().toISOString(),
        }));
        return json({ ok: true });
      }

      // ── 以下都需要管理密码 ──
      if (!isAdmin) return json({ error: 'unauthorized' }, 401);

      // 管理：完整状态（时段 + 所有邀请）
      if (path === '/admin/state' && request.method === 'GET') {
        const slots = await getList(env, 'meet:slots');
        const requests = await getAllRequests(env);
        return json({
          slots: slots.map(({ id, date, start, end }) => ({
            id, date, start, end, status: computeStatus(id, requests),
          })),
          requests,
        });
      }

      // 管理：添加/删除时段
      if (path === '/admin/slots' && request.method === 'POST') {
        const body = await request.json();
        const slots = await getList(env, 'meet:slots');

        if (body.action === 'add') {
          const { date, start, end } = body;
          if (!date || !start || !end) return json({ error: '缺少 date/start/end' }, 400);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return json({ error: '日期格式无效' }, 400);
          }
          const dt = new Date(date + 'T00:00:00Z');
          if (isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== date) {
            return json({ error: '日期格式无效' }, 400);
          }
          const timeRe = /^(\d{2}):(\d{2})$/;
          const sm = String(start).match(timeRe);
          const em = String(end).match(timeRe);
          const validTime = (m) => {
            if (!m) return false;
            const h = +m[1], min = +m[2];
            return h >= 0 && h <= 23 && min >= 0 && min <= 59;
          };
          if (!validTime(sm) || !validTime(em)) {
            return json({ error: '时间格式无效' }, 400);
          }
          if (!(end > start)) {
            return json({ error: '结束时间必须晚于开始时间' }, 400);
          }
          // 同日区间重叠则拒绝（相邻如 18-19 和 19-20 允许）
          const overlap = slots.some(s =>
            s.date === date && start < s.end && end > s.start);
          if (overlap) return json({ error: '这个时段和已有时段重叠了' }, 409);
          slots.push({ id: crypto.randomUUID(), date, start, end });
          slots.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
        } else if (body.action === 'delete') {
          const idx = slots.findIndex(s => s.id === body.id);
          if (idx === -1) return json({ error: '时段不存在' }, 404);
          const requests = await getAllRequests(env);
          if (computeStatus(body.id, requests) !== 'free') {
            return json({ error: '这个时段还有未处理或已确认的邀请，不能删' }, 409);
          }
          slots.splice(idx, 1);
        } else {
          return json({ error: '未知 action' }, 400);
        }

        await putList(env, 'meet:slots', slots);
        return json({ ok: true, slots });
      }

      // 管理：确认 / 拒绝邀请
      if (path === '/admin/decide' && request.method === 'POST') {
        const { requestId, action } = await request.json();
        const slots = await getList(env, 'meet:slots');
        const requests = await getAllRequests(env);

        const req = requests.find(r => r.id === requestId);
        if (!req) return json({ error: '邀请不存在' }, 404);
        if (req.status !== 'pending') return json({ error: '这条邀请已经处理过了' }, 409);

        if (action === 'confirm') {
          const slot = slots.find(s => s.id === req.slotId);
          if (!slot) return json({ error: '这个时段不存在了' }, 409);
          if (computeStatus(req.slotId, requests) === 'confirmed') {
            return json({ error: '这个时段已经确认过别的邀请了' }, 409);
          }
          req.status = 'confirmed';
          await env.KV.put(REQ_PREFIX + req.id, JSON.stringify(req));
          // 确认一条即锁定该 slot：同 slot 的其他 pending 邀请自动置为 rejected
          const others = requests.filter(
            r => r.slotId === req.slotId && r.id !== req.id && r.status === 'pending');
          await Promise.all(others.map(r => {
            r.status = 'rejected';
            return env.KV.put(REQ_PREFIX + r.id, JSON.stringify(r));
          }));
        } else if (action === 'reject') {
          req.status = 'rejected';
          await env.KV.put(REQ_PREFIX + req.id, JSON.stringify(req));
          // slot 状态是推导的，reject 后若无其他 pending/confirmed 会自动回落为 free
        } else {
          return json({ error: '未知 action' }, 400);
        }

        return json({ ok: true });
      }

      return json({ error: 'not found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: '服务器出错了，稍后再试' }, 500);
    }
  },
};
