/**
 * Cloudflare Worker — 约饭 Scheduling Backend
 *
 * 部署步骤：
 * 1. 打开 https://dash.cloudflare.com → Workers & Pages → Create Worker
 * 2. 给 Worker 起名，比如 "ljw-meet"（也可以直接加到现有的 ljw-chat Worker 里，但建议分开）
 * 3. 把这个文件的内容粘贴进去，点 Deploy
 * 4. 在 Worker Settings → Variables and Secrets 里添加：
 *    - ADMIN_KEY = 你自己设一个管理密码（类型选 Secret），确认/管理时段要用
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
