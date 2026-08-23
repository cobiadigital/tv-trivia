// The game runs entirely in the browser: the question bank is a static file and
// all state lives on the client, so this Worker only needs to answer the few
// paths that aren't files in ./public.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, service: 'tv-trivia' });
    }

    // Unknown path: hand back the game rather than a bare 404, so a stray
    // deep link from a TV browser still lands somewhere useful.
    const index = new URL('/index.html', url.origin);
    return env.ASSETS.fetch(new Request(index, request));
  },
};
