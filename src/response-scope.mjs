import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(id);
const unavailable = () => Object.assign(new Error('Response not available for this API key and route'), { status: 404, type: 'not_found_error' });

// Intentionally process-local: after restart, expiry or eviction, old objects are denied.
// Only hashes and public model IDs are stored, never upstream credentials or response bodies.
export function createResponseScope({ maxEntries = 10000, ttlMs = 3600000, now = Date.now } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('Invalid response scope bounds');
  const entries = new Map();
  const index = (owner, id) => JSON.stringify([owner, id]);
  const prune = () => {
    const time = now();
    for (const [key, record] of entries) {
      if (record.expires > time) break;
      entries.delete(key);
    }
  };
  return {
    remember(owner, id, binding) {
      if (!validId(id)) return;
      prune();
      const key = index(owner, id);
      // An ID cannot silently migrate between models/routes, even on a collision.
      const previous = entries.get(key);
      if (previous && (previous.fingerprint !== binding.fingerprint || previous.modelId !== binding.modelId)) return;
      entries.delete(key);
      entries.set(key, { ...binding, expires: now() + ttlMs });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    require(owner, id) {
      prune();
      const record = validId(id) && entries.get(index(owner, id));
      if (!record || record.expires <= now()) throw unavailable();
      return record;
    },
    forget(owner, id) { entries.delete(index(owner, id)); },
    get size() { prune(); return entries.size; },
  };
}

// A bounded structural scanner: it retains at most a short JSON key/ID and 64
// stack frames, not the response body. Huge text/tool arguments are skipped.
// IDs in output items, tool arguments or arbitrary nested objects are not trusted.
function idScanner(onId, sse) {
  const stack = [];
  let started = false, done = false, string = false, escaped = false, raw = '', overflow = false, role, path;
  const valuePath = () => {
    const frame = stack.at(-1);
    return frame ? [...frame.path, frame.array ? '*' : frame.key] : [];
  };
  const consume = () => { const frame = stack.at(-1); if (frame && !frame.array) frame.key = null; };
  const idPath = p => sse ? (p.length === 2 && p[0] === 'response' && p[1] === 'id') || (p.length === 1 && p[0] === 'response_id') : p.length === 1 && p[0] === 'id';
  return text => {
    if (done) return;
    for (const ch of text) {
      if (string) {
        if (ch === '"' && !escaped) {
          string = false;
          let value;
          if (!overflow) { try { value = JSON.parse('"' + raw + '"'); } catch { done = true; return; } }
          if (role === 'key') { stack.at(-1).key = value; stack.at(-1).keyExpected = false; }
          else { if (idPath(path) && validId(value)) onId(value); consume(); }
          raw = '';
        } else {
          if (raw.length < 2048) raw += ch; else overflow = true;
          if (escaped) escaped = false; else if (ch.charCodeAt(0) === 92) escaped = true;
        }
        continue;
      }
      if (/\s/.test(ch)) continue;
      if (!started) { if (ch !== '{') { done = true; return; } started = true; }
      if (ch === '"') {
        string = true; escaped = false; raw = ''; overflow = false;
        role = stack.at(-1)?.keyExpected ? 'key' : 'value';
        path = role === 'value' ? valuePath() : [];
      } else if (ch === '{' || ch === '[') {
        const nextPath = valuePath(); consume();
        if (stack.length >= 64) { done = true; return; }
        stack.push({ path: nextPath, array: ch === '[', key: null, keyExpected: ch === '{' });
      } else if (ch === '}' || ch === ']') {
        stack.pop();
        if (!stack.length) { done = true; return; }
      } else if (ch === ',') {
        const frame = stack.at(-1); if (frame && !frame.array) frame.keyExpected = true;
      } else if (ch !== ':') consume();
    }
  };
}

export function createResponseObserver(contentType, onId) {
  const sse = /^text\/event-stream(?:;|$)/i.test(contentType);
  const json = /^(?:application\/(?:[a-z0-9.+-]+\+)?json)(?:;|$)/i.test(contentType);
  const decoder = new StringDecoder('utf8');
  let scan = idScanner(onId, sse);
  let prefix = '', mode = 'prefix';
  function observe(text) {
    if (!sse) { if (json) scan(text); return; }
    // Stream each data line directly into its event scanner. Even a single
    // enormous SSE line cannot create an unbounded line/event buffer.
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      const end = newline < 0 ? text.length : newline;
      let part = text.slice(start, end);
      if (mode === 'prefix') {
        let used = 0;
        while (used < part.length && mode === 'prefix') {
          prefix += part[used++];
          if (prefix === 'data:') mode = 'data';
          else if (!'data:'.startsWith(prefix) && prefix !== '\r') mode = 'skip';
        }
        part = part.slice(used);
      }
      if (mode === 'data') scan(part);
      if (newline < 0) return;
      if (mode === 'prefix' && (prefix === '' || prefix === '\r')) scan = idScanner(onId, true);
      else if (mode === 'data') scan('\n');
      mode = 'prefix'; prefix = ''; start = end + 1;
    }
  }
  return new Transform({
    transform(chunk, encoding, callback) {
      try { observe(decoder.write(chunk)); callback(null, chunk); } catch (error) { callback(error); }
    },
    flush(callback) { try { observe(decoder.end()); callback(); } catch (error) { callback(error); } },
  });
}
