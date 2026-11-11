import { Transform } from 'node:stream';

const MASK = '[REDACTED]';

// A finite, acyclic NFA avoids enumerating exponentially many mixed raw/JSON
// spellings. Only JSON escapes and encodeURIComponent spellings are recognized;
// this is not a guarantee against arbitrary upstream encodings or encryption.
function compile(values, bytes) {
  const nodes = [{ edges: new Map(), terminal: false }];
  // Share logical credential prefixes, while keeping raw/JSON spellings and
  // whole-key URI spellings in separate tries. Joining those two languages
  // would incorrectly accept a mixture of partial URI and JSON encodings.
  const rawChildren = new Map(), uriChildren = new Map();
  function children(index, from) {
    let result = index.get(from);
    if (!result) index.set(from, result = new Map());
    return result;
  }
  const node = () => { nodes.push({ edges: new Map(), terminal: false }); return nodes.length - 1; };
  const units = value => bytes ? [...Buffer.from(value)] : value.split('').map(c => c.charCodeAt(0));
  function edge(from, unit, to) {
    let targets = nodes[from].edges.get(unit);
    if (!targets) nodes[from].edges.set(unit, targets = new Set());
    targets.add(to);
  }
  function path(from, to, spelling, foldedHex = false) {
    const input = units(spelling);
    for (let i = 0; i < input.length; i++) {
      const next = i === input.length - 1 ? to : node();
      edge(from, input[i], next);
      // Only generated escape spellings reach this branch: raw key bytes
      // remain case-sensitive, including letters following literal backslashes.
      if (foldedHex && input[i] >= 97 && input[i] <= 102) edge(from, input[i] - 32, next);
      from = next;
    }
  }
  for (const value of values) {
    let from = 0;
    for (const char of value) {
      const shared = children(rawChildren, from);
      if (shared.has(char)) { from = shared.get(char); continue; }
      const to = node();
      shared.set(char, to);
      const loneSurrogate = char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff;
      const spellings = new Set([JSON.stringify(char).slice(1, -1)]);
      if (!bytes || !loneSurrogate) spellings.add(char);
      if (char === '/') spellings.add(String.fromCharCode(92) + '/');
      for (const spelling of spellings) path(from, to, spelling);
      const escaped = char.split('').map(c => String.fromCharCode(92) + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
      path(from, to, escaped, true);
      from = to;
    }
    nodes[from].terminal = true;
    // URI encoding is an additional whole-key spelling, not recursive decoding.
    // Lone surrogates have no encodeURIComponent representation.
    try {
      const encoded = encodeURIComponent(value);
      if (encoded === value) continue; // Already covered by the raw spelling.
      let at = 0, state = 0;
      while (at < encoded.length) {
        const percent = encoded[at] === '%';
        const spelling = encoded.slice(at, at + (percent ? 3 : 1));
        const token = percent ? spelling.toLowerCase() : spelling;
        const shared = children(uriChildren, state);
        let next = shared.get(token);
        // encodeURIComponent produces uppercase hex; normalize just percent bytes.
        if (next === undefined) {
          next = node(); shared.set(token, next);
          path(state, next, token, percent);
        }
        state = next;
        at += spelling.length;
      }
      nodes[state].terminal = true;
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
    }
  }
  return nodes;
}

function scanner(nodes, bytes) {
  const empty = bytes ? Buffer.alloc(0) : '';
  const replacement = bytes ? Buffer.from(MASK) : MASK;
  let pending = empty;
  let savedStates = null, savedOffset = 0, savedMatch = -1;
  const slice = (value, start, end) => bytes ? value.subarray(start, end) : value.slice(start, end);
  const join = parts => bytes ? Buffer.concat(parts) : parts.join('');
  return (chunk, final = false) => {
    const input = pending.length ? (bytes ? Buffer.concat([pending, chunk]) : pending + chunk) : chunk;
    const parts = [];
    let cursor = 0, unchanged = 0;
    while (cursor < input.length) {
      let states = savedStates;
      let at = states ? savedOffset : cursor;
      let match = states ? savedMatch : -1;
      savedStates = null;
      if (!states) {
        const first = bytes ? input[cursor] : input.charCodeAt(cursor);
        if (!nodes[0].edges.has(first)) { cursor++; continue; }
        states = [0];
      }
      while (at < input.length && states.length) {
        const unit = bytes ? input[at] : input.charCodeAt(at);
        const next = new Set();
        for (const state of states) {
          for (const target of nodes[state].edges.get(unit) ?? []) next.add(target);
        }
        at++;
        states = [];
        for (const target of next) {
          if (nodes[target].terminal) match = at;
          if (nodes[target].edges.size) states.push(target);
        }
      }
      if (states.length && !final) {
        // Delay only an actual candidate prefix. In particular, a complete
        // short key must wait while a longer key at this same start can match.
        if (cursor > unchanged) parts.push(slice(input, unchanged, cursor));
        const tail = slice(input, cursor);
        pending = bytes ? Buffer.from(tail) : tail;
        savedStates = states;
        savedOffset = at - cursor;
        savedMatch = match < 0 ? -1 : match - cursor;
        return join(parts);
      }
      if (match >= 0) {
        if (cursor > unchanged) parts.push(slice(input, unchanged, cursor));
        parts.push(replacement);
        cursor = match;
        unchanged = cursor;
      } else {
        cursor++;
      }
    }
    if (cursor > unchanged) parts.push(slice(input, unchanged, cursor));
    pending = empty;
    savedStates = null;
    return join(parts);
  };
}

export function secretRedactor(secrets) {
  const values = [...new Set(secrets)].filter(value => value.length);
  const textNodes = compile(values, false);
  const byteNodes = compile(values, true);
  return {
    text(value) { return scanner(textNodes, false)(String(value), true); },
    stream() {
      const redact = scanner(byteNodes, true);
      return new Transform({
        transform(chunk, encoding, callback) {
          // One push per input chunk preserves native Transform backpressure.
          // Retained input is bounded by the longest supported key spelling,
          // never an SSE event, a complete JSON document, or a fixed-size block.
          const output = redact(chunk);
          if (output.length) this.push(output);
          callback();
        },
        flush(callback) {
          const output = redact(Buffer.alloc(0), true);
          if (output.length) this.push(output);
          callback();
        },
      });
    },
  };
}
