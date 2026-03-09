// stavla-photos Cloudflare Worker
// Löser Google Photos delningslänkar till inbäddningsbara bild-URL:er
// Deploy: https://dash.cloudflare.com → Workers → Create → Klistra in detta

export default {
  async fetch(request) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET',
        }
      });
    }

    const { searchParams } = new URL(request.url);
    const photoUrl = searchParams.get('url');

    if (!photoUrl || !photoUrl.includes('photos.google.com')) {
      return json({ error: 'Ogiltig URL — bara photos.google.com stöds' }, 400);
    }

    try {
      const resp = await fetch(photoUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Twitterbot/1.0)',
          'Accept': 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      });

      if (!resp.ok) return json({ error: `Google svarade ${resp.status}` }, 502);

      const html = await resp.text();

      // Prova flera varianter av og:image-taggen
      const patterns = [
        /<meta\s+property="og:image"\s+content="([^"]+)"/i,
        /<meta\s+content="([^"]+)"\s+property="og:image"/i,
      ];

      let imageUrl = null;
      for (const p of patterns) {
        const m = html.match(p);
        if (m) { imageUrl = m[1].replace(/&amp;/g, '&'); break; }
      }

      if (!imageUrl) return json({ error: 'Hittade ingen bild-URL på sidan' }, 404);

      return json({ imageUrl }, 200);

    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400',
    }
  });
}
