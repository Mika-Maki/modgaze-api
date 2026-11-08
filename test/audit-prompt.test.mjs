import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSystemPrompt } from '../src/request-audit.mjs';

test('large valid system text-block arrays do not exceed the argument stack', () => {
  const content = Array.from({ length: 150000 }, () => ({ type: 'text', text: 'x' }));
  const expected = new Array(content.length).fill('x').join('\n');
  assert.equal(extractSystemPrompt({ messages: [{ role: 'system', content }] }, 'chat'), expected);
  assert.equal(extractSystemPrompt({ instructions: content }, 'responses'), expected);
});
