// TTL cache backed by localStorage, with an in-memory fallback for private
// browsing or storage-disabled contexts. Used to stay well inside the free
// APIs' rate limits — repeated clicks should not re-hammer the same endpoints.

const MEMORY = new Map();
const PREFIX = 'scp:';

function storage() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const probe = `${PREFIX}__probe`;
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null; // Safari private mode throws on setItem
  }
}

const STORE = storage();

/** @returns {*} the cached value, or undefined when missing or expired. */
export function cacheGet(key, now = Date.now()) {
  const full = PREFIX + key;

  const mem = MEMORY.get(full);
  if (mem) {
    if (mem.expires > now) return mem.value;
    MEMORY.delete(full);
  }

  if (!STORE) return undefined;
  try {
    const raw = STORE.getItem(full);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.expires !== 'number') return undefined;
    if (parsed.expires <= now) {
      STORE.removeItem(full);
      return undefined;
    }
    MEMORY.set(full, parsed);
    return parsed.value;
  } catch {
    return undefined;
  }
}

export function cacheSet(key, value, ttlMs, now = Date.now()) {
  const full = PREFIX + key;
  const record = { value, expires: now + ttlMs };
  MEMORY.set(full, record);
  if (!STORE) return;
  try {
    STORE.setItem(full, JSON.stringify(record));
  } catch {
    // Quota exceeded — drop our own expired entries and try once more.
    pruneExpired(now);
    try { STORE.setItem(full, JSON.stringify(record)); } catch { /* memory only */ }
  }
}

/** Run `producer` only on a cache miss. */
export async function cached(key, ttlMs, producer, now = Date.now()) {
  const hit = cacheGet(key, now);
  if (hit !== undefined) return hit;
  const value = await producer();
  cacheSet(key, value, ttlMs, now);
  return value;
}

export function pruneExpired(now = Date.now()) {
  for (const [k, v] of MEMORY) if (v.expires <= now) MEMORY.delete(k);
  if (!STORE) return;
  const doomed = [];
  for (let i = 0; i < STORE.length; i++) {
    const k = STORE.key(i);
    if (!k || !k.startsWith(PREFIX)) continue;
    try {
      const parsed = JSON.parse(STORE.getItem(k));
      if (!parsed || typeof parsed.expires !== 'number' || parsed.expires <= now) doomed.push(k);
    } catch {
      doomed.push(k);
    }
  }
  for (const k of doomed) { try { STORE.removeItem(k); } catch { /* ignore */ } }
}

/** Test seam — clears everything this module owns. */
export function cacheClear() {
  MEMORY.clear();
  if (!STORE) return;
  const doomed = [];
  for (let i = 0; i < STORE.length; i++) {
    const k = STORE.key(i);
    if (k && k.startsWith(PREFIX)) doomed.push(k);
  }
  for (const k of doomed) { try { STORE.removeItem(k); } catch { /* ignore */ } }
}
