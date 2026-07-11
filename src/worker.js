/* Tumor Tracker Worker — serves the static app and a small publish API.
   Published datasets live in the PUBLISHED KV namespace under `pub:<CODE>`;
   the gallery summary is stored as KV *metadata* so listing needs no reads. */

const CODE_RE = /^[A-HJKMNP-Z2-9]{6}$/;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Robots-Tag': 'noindex',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

// Serve index.html for a viewer route, stamped noindex. The app reads
// location.pathname to decide what to render.
async function serveApp(env, url) {
  const res = await env.ASSETS.fetch(new Request(new URL('/', url.origin)));
  const out = new Response(res.body, res);
  out.headers.set('X-Robots-Tag', 'noindex');
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const viewMatch = path.match(/^\/p\/([A-HJKMNP-Z2-9]{6})$/);
    if (viewMatch || path === '/explore') return serveApp(env, url);

    if (path.startsWith('/api/')) {
      return json({ error: 'Not found.' }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
