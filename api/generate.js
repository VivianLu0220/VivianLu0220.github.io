const ALLOWED_FLOWERS = [
  'roses', 'spray roses', 'peonies', 'delphiniums', 'carnations',
  'tulips', 'lisianthus', 'hydrangea', 'sunflowers', 'daisies',
  'lilies', 'chamomile', 'ranunculus', 'orchids', 'bellflowers',
  'gladioli', 'stock', 'calla lilies', 'dahlias', 'irises',
  'eucalyptus', "baby's breath", 'dried flowers', 'alpine fern',
  'freesia', 'scabiosa', 'agapanthus', 'lotus', 'jasmine',
];

const ALLOWED_PALETTES = [
  'warm pink', 'soft blush', 'coral', 'champagne', 'cream',
  'red', 'purple', 'lavender', 'yellow', 'orange', 'green',
  'blue', 'white', 'autumn tones', 'muted dusty tones',
  'dopamine vibrant', 'pastel', 'moody dark',
];

const rateLimitMap = new Map();
const DAILY_LIMIT_PER_IP = 5;
const DAILY_LIMIT_GLOBAL = 200;
let globalCount = 0;
let globalResetDay = new Date().toDateString();

function getRateKey(ip) {
  const today = new Date().toDateString();
  if (today !== globalResetDay) {
    globalCount = 0;
    globalResetDay = today;
    rateLimitMap.clear();
  }
  const entry = rateLimitMap.get(ip);
  if (!entry || entry.day !== today) {
    rateLimitMap.set(ip, { day: today, count: 0 });
    return rateLimitMap.get(ip);
  }
  return entry;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const origin = req.headers.origin || req.headers.referer || '';
  const host = req.headers.host || '';
  const isLocal = origin.includes('localhost') || origin.includes('127.0.0.1');
  const isSameHost = origin.includes(host);
  if (!isLocal && !isSameHost) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const entry = getRateKey(ip);
  if (entry.count >= DAILY_LIMIT_PER_IP) {
    return res.status(429).json({
      error: 'You have used all 5 generations for today. Come back tomorrow!',
    });
  }
  if (globalCount >= DAILY_LIMIT_GLOBAL) {
    return res.status(429).json({
      error: 'The generator is resting for today — too many bouquets! Try again tomorrow.',
    });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { flowers, palette } = body;
  if (!Array.isArray(flowers) || flowers.length === 0 || flowers.length > 5) {
    return res.status(400).json({ error: 'Select 1–5 flowers.' });
  }

  const invalid = flowers.filter(f => !ALLOWED_FLOWERS.includes(f));
  if (invalid.length) {
    return res.status(400).json({ error: `Unknown flower(s): ${invalid.join(', ')}` });
  }

  if (palette && !ALLOWED_PALETTES.includes(palette)) {
    return res.status(400).json({ error: `Unknown palette: ${palette}` });
  }

  const flowerStr = flowers.join(', ');
  const paletteStr = palette ? `, ${palette} tones` : '';
  const prompt = `a VIVBLOOM bouquet with ${flowerStr}${paletteStr}, hand-tied, kraft paper wrap`;

  const FAL_KEY = process.env.FAL_KEY;
  const LORA_URL = process.env.LORA_URL;
  const LORA_SCALE = parseFloat(process.env.LORA_SCALE || '1.0');

  if (!FAL_KEY || !LORA_URL) {
    return res.status(500).json({ error: 'Server configuration incomplete.' });
  }

  try {
    const falRes = await fetch('https://queue.fal.run/fal-ai/flux-lora', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${FAL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        loras: [{ path: LORA_URL, scale: LORA_SCALE }],
        image_size: 'square_hd',
        num_images: 1,
      }),
    });

    if (!falRes.ok) {
      const errText = await falRes.text();
      console.error('fal.ai queue error:', falRes.status, errText);
      return res.status(502).json({ error: 'Failed to start generation.' });
    }

    const queueData = await falRes.json();
    const requestId = queueData.request_id;

    if (!requestId) {
      console.error('No request_id from fal.ai:', queueData);
      return res.status(502).json({ error: 'Failed to start generation.' });
    }

    let result;
    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 2000));

      const statusRes = await fetch(
        `https://queue.fal.run/fal-ai/flux-lora/requests/${requestId}/status`,
        { headers: { 'Authorization': `Key ${FAL_KEY}` } }
      );
      const statusData = await statusRes.json();

      if (statusData.status === 'COMPLETED') {
        const resultRes = await fetch(
          `https://queue.fal.run/fal-ai/flux-lora/requests/${requestId}`,
          { headers: { 'Authorization': `Key ${FAL_KEY}` } }
        );
        result = await resultRes.json();
        break;
      }

      if (statusData.status === 'FAILED') {
        console.error('fal.ai generation failed:', statusData);
        return res.status(502).json({ error: 'Generation failed. Please try again.' });
      }
    }

    if (!result) {
      return res.status(504).json({ error: 'Generation timed out. Please try again.' });
    }

    entry.count++;
    globalCount++;

    const imageUrl = result.images?.[0]?.url;
    if (!imageUrl) {
      console.error('No image in fal.ai result:', result);
      return res.status(502).json({ error: 'No image returned.' });
    }

    return res.status(200).json({
      image_url: imageUrl,
      remaining: DAILY_LIMIT_PER_IP - entry.count,
    });
  } catch (err) {
    console.error('generate error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}
