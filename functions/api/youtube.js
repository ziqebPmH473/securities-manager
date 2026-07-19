// Cloudflare Pages Function: YouTubeチャンネルの新着動画（フェーズN3）
//   GET /api/youtube?channels=UCxxxx,UCyyyy[&max=6] → { items:[{title,videoId,link,published,channel,channelId,thumb}] }
// YouTube公式のチャンネルRSS（無料・キー不要）。要約はしない（別途 /api/youtube-summary で Gemini 要約）。
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const ids = (url.searchParams.get('channels') || '').split(',').map(s => s.trim()).filter(s => /^UC[\w-]{20,}$/.test(s)).slice(0, 12);
  const max = Math.min(10, Math.max(1, parseInt(url.searchParams.get('max') || '6', 10)));
  if (!ids.length) return json({ items: [] });
  const arrs = await Promise.all(ids.map(id => fetchChannel(id, max).catch(() => [])));
  const items = [].concat(...arrs).sort((a, b) => (b.published || '') < (a.published || '') ? -1 : 1);
  return json({ items });
}

async function fetchChannel(channelId, max) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; securities-manager/1.0)' },
      signal: ctrl.signal, cf: { cacheTtl: 600, cacheEverything: true },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const channel = clean((xml.match(/<title>([\s\S]*?)<\/title>/) || [])[1]) || '';
    const out = [];
    const re = /<entry>([\s\S]*?)<\/entry>/g; let m;
    while ((m = re.exec(xml)) && out.length < max) {
      const e = m[1];
      const videoId = (e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
      const title = clean((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
      const published = (e.match(/<published>([^<]+)<\/published>/) || [])[1] || null;
      if (!videoId || !title) continue;
      out.push({
        title, videoId, link: `https://www.youtube.com/watch?v=${videoId}`,
        published, channel, channelId,
        thumb: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      });
    }
    return out;
  } finally { clearTimeout(timer); }
}

function clean(s) {
  if (!s) return null;
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&').trim() || null;
}
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
