import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { secretRedactor } from '../src/secrets.mjs';

const MASK = '[REDACTED]';
const unicode = value => value.split('').map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
function mixed(value) {
  return Array.from(value, (c, i) => i % 2 ? unicode(c) : JSON.stringify(c).slice(1, -1)).join('');
}
async function stream(redact, chunks) {
  const output = [];
  await pipeline(Readable.from(chunks), redact.stream(), new Writable({
    write(chunk, encoding, callback) { output.push(chunk); callback(); },
  }));
  return Buffer.concat(output);
}
async function everySplit(redact, input, expected) {
  const bytes = Buffer.from(input);
  for (let cut = 0; cut <= bytes.length; cut++) {
    assert.deepEqual(await stream(redact, [bytes.subarray(0, cut), bytes.subarray(cut)]), Buffer.from(expected));
  }
  assert.deepEqual(await stream(redact, [...bytes].map(byte => Buffer.from([byte]))), Buffer.from(expected));
}

// All credentials here are synthetic test fixtures, never live configuration.
for (const [name, key] of [['ascii', 'fake-z+/='], ['non-ASCII', '假é🔑z'], ['JSON special', 'fake"/\\\nend']]) {
  test('text and stream redact supported spellings: ' + name, async () => {
    const redact = secretRedactor([key]);
    const spellings = [JSON.stringify(key).slice(1, -1), mixed(key), unicode(key), unicode(key).replace(/[a-f]/g, c => c.toUpperCase())];
    for (const spelling of spellings) {
      const input = '{"keep":"unchanged", "credential":"' + spelling + '"}\n';
      assert.equal(JSON.parse(input).credential, key);
      const expected = '{"keep":"unchanged", "credential":"' + MASK + '"}\n';
      assert.equal(redact.text(input), expected);
      assert.equal(JSON.parse(redact.text(input)).credential, MASK);
      await everySplit(redact, input, expected);
    }
    await everySplit(redact, 'left|' + key + '|right', 'left|' + MASK + '|right');
    assert.equal(redact.text('left|' + key + '|right'), 'left|' + MASK + '|right');
    for (const encoded of [encodeURIComponent(key), encodeURIComponent(key).replace(/%[0-9A-F]{2}/g, c => c.toLowerCase())]) {
      assert.equal(redact.text('url=' + encoded), 'url=' + MASK);
      await everySplit(redact, 'url=' + encoded, 'url=' + MASK);
    }
  });
}

test('all possible chunk partitions preserve raw, mixed and full Unicode redaction', async () => {
  for (const [key, input] of [['az', 'az'], ['az', 'a\\u007a'], ['z', '\\u007a']]) {
    const redact = secretRedactor([key]);
    const bytes = Buffer.from(input);
    for (let mask = 0; mask < 2 ** (bytes.length - 1); mask++) {
      const chunks = [];
      let start = 0;
      for (let at = 1; at < bytes.length; at++) if (mask & (1 << (at - 1))) {
        chunks.push(bytes.subarray(start, at)); start = at;
      }
      chunks.push(bytes.subarray(start));
      assert.equal((await stream(redact, chunks)).toString(), MASK);
    }
  }
});

test('longest overlapping credential wins before a short prefix can consume it', async () => {
  const short = 'fake-prefix';
  const long = short + '-private-tail';
  for (const keys of [[short, long], [long, short]]) {
    const redact = secretRedactor(keys);
    for (const spelling of [long, mixed(long), unicode(long), encodeURIComponent(long)]) {
      assert.equal(redact.text(spelling), MASK);
      await everySplit(redact, spelling, MASK);
    }
    assert.equal((await stream(redact, [Buffer.from(short), Buffer.from('-private'), Buffer.from('-tail!')])).toString(), MASK + '!');
    assert.equal((await stream(redact, [Buffer.from(short)])).toString(), MASK);
    assert.equal((await stream(redact, [Buffer.from(short + '-no-match')])).toString(), MASK + '-no-match');
  }
});

test('a complete later secret does not bypass an earlier incomplete candidate', async () => {
  const redact = secretRedactor(['abcde', 'bc']);
  assert.equal((await stream(redact, [Buffer.from('abc'), Buffer.from('de')])).toString(), MASK);
  assert.equal(redact.text('abcde'), MASK);
});

test('ordinary SSE events emit progressively without buffering a whole event or changing bytes', async () => {
  const redact = secretRedactor(['fake-secret-' + 'x'.repeat(8192)]).stream();
  const chunks = [];
  redact.on('data', chunk => chunks.push(chunk));
  const events = [Buffer.from(': ready\r\n\r\n'), Buffer.from('data: {"delta":"你好"}\n\n'), Buffer.from('data: [DONE]\n\n')];
  for (let i = 0; i < events.length; i++) {
    redact.write(events[i]);
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat(events.slice(0, i + 1)));
  }
  const ended = once(redact, 'end');
  redact.end();
  await ended;
});

test('non-secret bytes and failed/unfinished prefixes are preserved exactly', async () => {
  const redact = secretRedactor(['fake-z']);
  const input = Buffer.concat([Buffer.from([0xff, 0xfe, 0xc0, 0x80]), Buffer.from('plain \\u0061 \\u00G1 \\U0066 fake-')]);
  for (let cut = 0; cut <= input.length; cut++) assert.deepEqual(await stream(redact, [input.subarray(0, cut), input.subarray(cut)]), input);
  const text = 'plain \\u0061 \\u00G1 \\U0066 fake-';
  assert.equal(redact.text(text), text);
});

test('native stream backpressure bounds unread output', async () => {
  const redact = secretRedactor(['fake-secret']).stream();
  const chunk = Buffer.alloc(4096, 0x78);
  let accepted = 0;
  while (redact.write(chunk)) {
    accepted++;
    assert.ok(accepted < 128, 'writable must stop accepting unread data');
  }
  assert.ok(redact.readableLength <= redact.readableHighWaterMark + chunk.length);
  redact.destroy();
});

test('shared prefixes preserve separate URI/JSON languages, case sensitivity and longest matches', async () => {
  for (const [keys, input, expected] of [
    [['a/b'], 'a%2Fb a\\u002fb', MASK + ' ' + MASK],
    [['a/b'], 'a%2F\\u0062', 'a%2F\\u0062'],
    [['a/b', 'a%c'], 'a%2Fc', 'a%2Fc'],
    [['/Ab'], '%2fAb %2FAb %2fab', MASK + ' ' + MASK + ' %2fab'],
    [['\\u00af'], '\\u00AF', '\\u00AF'],
    [['a', 'ab', 'a/b'], 'ab a%2Fb a%2Fx', MASK + ' ' + MASK + ' ' + MASK + '%2Fx'],
    [['\ud800', '�', '😀', '😀x'], '\\ud800 😀x', MASK + ' ' + MASK],
  ]) {
    for (const ordered of [keys, [...keys].reverse()]) {
      const redact = secretRedactor(ordered);
      assert.equal(redact.text(input), expected);
      await everySplit(redact, input, expected);
    }
  }
});
