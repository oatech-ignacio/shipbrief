// Tiny REST helper for the seed script. Reads the site and credentials from the environment; never prints them.
export const SITE = (process.env.SHIPBRIEF_SITE || '').replace(/\/$/, '');
if (!SITE || !process.env.FORGE_EMAIL || !process.env.FORGE_API_TOKEN) throw new Error('Set SHIPBRIEF_SITE (https://<site>.atlassian.net), FORGE_EMAIL and FORGE_API_TOKEN in the environment.');
const auth = 'Basic ' + Buffer.from(`${process.env.FORGE_EMAIL}:${process.env.FORGE_API_TOKEN}`).toString('base64');
export async function call(method, path, body) {
  const res = await fetch(SITE + path, {
    method,
    headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text.slice(0, 500); }
  if (!res.ok) { const e = new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data).slice(0, 600)}`); e.status = res.status; throw e; }
  return data;
}
export const get = (p) => call('GET', p);
export const post = (p, b) => call('POST', p, b);
export const put = (p, b) => call('PUT', p, b);
