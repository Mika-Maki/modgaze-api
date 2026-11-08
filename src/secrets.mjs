import { Transform } from 'node:stream';
export function secretRedactor(secrets) {
  const values = [...new Set(secrets.flatMap(k => [k, JSON.stringify(k).slice(1, -1), encodeURIComponent(k)]))].filter(Boolean).sort((a, b) => b.length - a.length);
  const patterns = values.map(k => Buffer.from(k));
  const replacement = Buffer.from('[REDACTED]');
  return {
    text(value) { let result = String(value); for (const key of values) result = result.split(key).join('[REDACTED]'); return result; },
    stream() {
      let pending = Buffer.alloc(0);
      function drain(final, emit) {
        while (pending.length) {
          let index = -1, match;
          for (const pattern of patterns) {
            const found = pending.indexOf(pattern);
            if (found !== -1 && (index === -1 || found < index)) { index = found; match = pattern; }
          }
          if (index !== -1) {
            if (index) emit(pending.subarray(0, index));
            emit(replacement); pending = pending.subarray(index + match.length); continue;
          }
          let keep = 0;
          if (!final) for (const pattern of patterns) {
            for (let n = Math.min(pattern.length - 1, pending.length); n > keep; n--) {
              if (pending.subarray(pending.length - n).equals(pattern.subarray(0, n))) { keep = n; break; }
            }
          }
          if (pending.length > keep) emit(pending.subarray(0, pending.length - keep));
          pending = keep ? Buffer.from(pending.subarray(pending.length - keep)) : Buffer.alloc(0);
          break;
        }
      }
      return new Transform({
        transform(chunk, encoding, callback) { pending = Buffer.concat([pending, chunk]); drain(false, data => this.push(data)); callback(); },
        flush(callback) { drain(true, data => this.push(data)); callback(); },
      });
    },
  };
}
