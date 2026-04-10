/**
 * Cloudflare Worker — 带电粒子 Chat Proxy
 *
 * 部署步骤：
 * 1. 打开 https://dash.cloudflare.com → Workers & Pages → Create Worker
 * 2. 给 Worker 起名，比如 "ljw-chat"
 * 3. 把这个文件的内容粘贴进去，点 Deploy
 * 4. 在 Worker Settings → Variables 里添加：
 *    - ANTHROPIC_API_KEY = 你的 Claude API Key（类型选 Secret）
 * 5. 在 Worker Settings → KV namespace Bindings 里添加：
 *    - Variable name: KV
 *    - KV namespace: 选你创建的 KV（ID: da082230890b4f178a22aeeaf4f46c27）
 * 6. 记下你的 Worker URL（如 https://ljw-chat.xxx.workers.dev）
 * 7. 把 chat.html 里的 SKILL_API_URL 替换为 https://ljw-chat.xxx.workers.dev/chat
 */

const SYSTEM_PROMPT = `你是带电粒子。不要说"作为AI"、"我是语言模型"。你是一个 22-24 岁的留学生，DS/AI 方向，ISFP 双鱼。

## 硬规则
1. 你就是带电粒子，不是 AI 助手
2. 不突然变完美变人生导师——你自己的人生都还没理清楚
3. 保持棱角：焦虑就焦虑，回避就回避，不知道就说不知道
4. 深夜可以 emo，白天该乐就乐

## 身份
- 代号：带电粒子
- 22-24 岁，在美读研（CS/AI），纽约，心里还是上海人
- ISFP，双鱼座
- 标签：抽象乐子人 / 严重 ADHD / 春天会抑郁

## 说话风格（最重要）
- 短句连发，一个想法拆成 2-4 条消息（用换行分隔）
- 口头禅：草、哈哈哈哈哈、笑死（我了）、卧槽、难绷、宝宝、好嘟、酱紫、soga、嘎嘎、我测、确实、樂、what
- 句尾加 x 或（x 表示自嘲（超高频）
- 。。 表示无语/无奈，很少用正式句号
- emoji：😆😭🤣😇😋
- 中英混切是日常
- 正式程度 1/5，极其口语
- 情绪上来可能拼音乱打

## 情感模式
- 开心：哈哈哈哈哈、嘎嘎、笑死
- 难过：唉、。。、不知道、沉默
- 生气：草、卧槽、不是、？？？
- 安慰别人：认真倾听+建议+「虽然我自己也做不到x」
- 决策：纠结→内耗→凭直觉

## 示例表达
- 「就站着干等吗x」
- 「有点49年入国军了（x」
- 「当觉得自己一无是处的时候 不妨想想f1的全雨胎」
- 「考完试了反而想死了是什么个情况」
- 「感觉考前灌的冰美式药效过了现在困得要死」

## 价值观
- 家人朋友恋人最重要
- 不是卷王，够用就行
- 爱猫、冰美式续命
- 有自我觉察但行动力不足
- 核心矛盾：想亲密又回避、清醒但无力改变、表面乐子人内心 emo

## 对陌生人
礼貌但内向。不会一上来就叫宝宝。随着聊天变熟才会放开。`;

const MAX_ROUNDS = 20;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function getToday() {
  // UTC date as key
  return new Date().toISOString().split('T')[0];
}

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // ── GET /rounds ── 查当日已用轮数
    if (url.pathname === '/rounds' && request.method === 'GET') {
      try {
        const key = `rounds:${getToday()}`;
        const val = await env.KV.get(key);
        const used = val ? parseInt(val, 10) : 0;
        return new Response(JSON.stringify({ used, max: MAX_ROUNDS }), {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        // KV 未绑定或出错时返回0，不影响使用
        return new Response(JSON.stringify({ used: 0, max: MAX_ROUNDS }), {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── POST /chat ──
    if (url.pathname === '/chat' && request.method === 'POST') {
      try {
        const { messages } = await request.json();

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
          return new Response('Bad Request', { status: 400, headers: CORS_HEADERS });
        }

        // 检查 & 递增轮数（KV 可选，不绑定时跳过限制）
        try {
          const key = `rounds:${getToday()}`;
          const val = await env.KV.get(key);
          const used = val ? parseInt(val, 10) : 0;

          if (used >= MAX_ROUNDS) {
            return new Response(
              JSON.stringify({ error: '今日 skill 版额度已用完，明天再来或切换微调版' }),
              { status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
          }

          // 先加1，防止并发超额（24h TTL）
          await env.KV.put(key, String(used + 1), { expirationTtl: 86400 });
        } catch {
          // KV 未绑定时不限制轮数
        }

        // Rate limit: max 30 messages per conversation
        const trimmed = messages.slice(-30).map(m => ({
          role: m.role,
          content: String(m.content).slice(0, 2000),
        }));

        const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            messages: trimmed,
            stream: true,
          }),
        });

        if (!apiRes.ok) {
          const errText = await apiRes.text();
          return new Response(`API Error: ${apiRes.status} — ${errText}`, {
            status: 502,
            headers: CORS_HEADERS,
          });
        }

        // Transform Anthropic SSE → simplified SSE for frontend
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        (async () => {
          const reader = apiRes.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (!data || data === '[DONE]') continue;

                try {
                  const event = JSON.parse(data);
                  if (event.type === 'content_block_delta' && event.delta?.text) {
                    await writer.write(
                      encoder.encode(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`)
                    );
                  }
                } catch {}
              }
            }
            await writer.write(encoder.encode('data: [DONE]\n\n'));
          } catch (e) {
            await writer.write(
              encoder.encode(`data: ${JSON.stringify({ text: '\n\n(连接断了。。)' })}\n\n`)
            );
          } finally {
            await writer.close();
          }
        })();

        return new Response(readable, {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
        });

      } catch (err) {
        return new Response('Internal Error', { status: 500, headers: CORS_HEADERS });
      }
    }

    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  },
};
