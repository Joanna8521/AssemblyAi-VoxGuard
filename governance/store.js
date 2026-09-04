/**
 * Where a session's policy and audit live.
 *
 * This started as one object in module scope, which is invisibly wrong on a
 * laptop and immediately wrong anywhere else: two people opening the same URL
 * would share one policy, and whichever spoke last would silently overwrite the
 * other. A governance tool losing somebody's authorisation to a stranger is the
 * exact failure it exists to prevent.
 *
 * So state is per session, and the backing store is swappable. Memory is right
 * for one machine; anywhere that runs more than one process at a time needs a
 * store the processes share, and `KVStore` is the shape that takes.
 */

const TTL_MS = 1000 * 60 * 60 * 6;

const blank = () => ({ policy: null, audit: [], missionId: 'M-100', touched: Date.now() });

/**
 * In-process. Correct for a single long-lived server, wrong the moment there
 * are two of them, which is why the choice is made explicitly at startup rather
 * than inherited by accident.
 */
export class MemoryStore {
  #sessions = new Map();

  async get(id) {
    this.#sweep();
    if (!this.#sessions.has(id)) this.#sessions.set(id, blank());
    const s = this.#sessions.get(id);
    s.touched = Date.now();
    return s;
  }

  async put(id, session) {
    session.touched = Date.now();
    this.#sessions.set(id, session);
  }

  async clear(id) {
    this.#sessions.set(id, blank());
  }

  async count() {
    this.#sweep();
    return this.#sessions.size;
  }

  #sweep() {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, s] of this.#sessions) if (s.touched < cutoff) this.#sessions.delete(id);
  }
}

/**
 * Anything with get/set/delete over the network: Vercel KV, Upstash, Redis.
 *
 * Read-modify-write here is not atomic, and deliberately so rather than by
 * oversight: a session belongs to one person speaking into one microphone, so
 * concurrent writes to the same session are not a thing that happens. If that
 * ever stops being true, this needs a compare-and-set and the note should go.
 */
export class KVStore {
  constructor(kv, { prefix = 'signalbox:' } = {}) {
    this.kv = kv;
    this.prefix = prefix;
  }

  #key(id) { return `${this.prefix}${id}`; }

  async get(id) {
    const raw = await this.kv.get(this.#key(id));
    if (!raw) return blank();
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  async put(id, session) {
    session.touched = Date.now();
    await this.kv.set(this.#key(id), JSON.stringify(session), { ex: Math.floor(TTL_MS / 1000) });
  }

  async clear(id) {
    await this.kv.set(this.#key(id), JSON.stringify(blank()), { ex: Math.floor(TTL_MS / 1000) });
  }

  async count() {
    return null; // Not worth a scan over the keyspace to fill in a status line.
  }
}

/**
 * Which session a request belongs to.
 *
 * A cookie, because the alternative is a header the voice client would have to
 * carry and the audit trail would have to trust. There is no login here and no
 * claim that this identifies a person: it separates one browser's policy from
 * another's, which is all it is for.
 */
export function sessionIdFrom(req, res) {
  const cookies = Object.fromEntries((req.headers.cookie ?? '')
    .split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2));

  if (cookies.sb_session && /^[a-f0-9]{32}$/.test(cookies.sb_session)) return cookies.sb_session;

  const id = crypto.randomUUID().replace(/-/g, '');
  res.setHeader('set-cookie',
    `sb_session=${id}; Path=/; Max-Age=${Math.floor(TTL_MS / 1000)}; SameSite=Lax; HttpOnly`);
  return id;
}
