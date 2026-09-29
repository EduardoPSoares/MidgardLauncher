const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
    },
  });
}

function cors() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return cors();
    }

    // Validate API key
    const apiKey = request.headers.get('X-Api-Key');
    if (!apiKey || apiKey !== env.API_KEY) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const url = new URL(request.url);

    if (url.pathname === '/heartbeat' && request.method === 'POST') {
      return handleHeartbeat(request, env);
    }

    if (url.pathname === '/leave' && request.method === 'POST') {
      return handleLeave(request, env);
    }

    return json({ error: 'Not Found' }, 404);
  },
};

async function handleHeartbeat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { uuid } = body;
  let { server } = body;

  if (!uuid || !server || !UUID_REGEX.test(uuid)) {
    return json({ error: 'Invalid uuid or server' }, 400);
  }

  if (typeof server !== 'string' || server.length > 253) {
    return json({ error: 'Invalid server' }, 400);
  }

  // Normalize server address for consistent matching
  server = server.toLowerCase().trim();
  if (server.endsWith(':25565')) {
    server = server.slice(0, -6);
  }

  const now = Math.floor(Date.now() / 1000);

  // Upsert player
  await env.DB.prepare(
    'INSERT OR REPLACE INTO players (uuid, server, last_seen) VALUES (?, ?, ?)'
  )
    .bind(uuid, server, now)
    .run();

  // Clean up stale entries (older than 120 seconds)
  await env.DB.prepare('DELETE FROM players WHERE last_seen < ?')
    .bind(now - 120)
    .run();

  // Get all players on same server
  const results = await env.DB.prepare(
    'SELECT uuid FROM players WHERE server = ? AND last_seen > ?'
  )
    .bind(server, now - 120)
    .all();

  const players = results.results.map((r) => r.uuid);

  return json({ players });
}

async function handleLeave(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { uuid } = body;

  if (!uuid || !UUID_REGEX.test(uuid)) {
    return json({ error: 'Invalid uuid' }, 400);
  }

  await env.DB.prepare('DELETE FROM players WHERE uuid = ?').bind(uuid).run();

  return json({ ok: true });
}
