import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJsonlParser } from '../src/jsonl.js';

test('parses two messages in one chunk', () => {
  const out = [];
  const feed = createJsonlParser((m) => out.push(m));
  feed('{"a":1}\n{"b":2}\n');
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});

test('parses split chunks', () => {
  const out = [];
  const feed = createJsonlParser((m) => out.push(m));
  feed('{"a":1}\n{"b"');
  feed(':2}\r\n\n');
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});

test('non-json goes to onRaw', () => {
  const out = [], raw = [];
  const feed = createJsonlParser((m) => out.push(m), (l) => raw.push(l));
  feed('oops\n{"ok":true}\n');
  assert.deepEqual(out, [{ ok: true }]);
  assert.deepEqual(raw, ['oops']);
});

test('ignores empty lines', () => {
  const out = [], raw = [];
  const feed = createJsonlParser((m) => out.push(m), (l) => raw.push(l));
  feed('\n\r\n   \n{"x":1}\n');
  assert.deepEqual(out, [{ x: 1 }]);
  assert.deepEqual(raw, []);
});

test('accepts CRLF line endings', () => {
  const out = [];
  const feed = createJsonlParser((m) => out.push(m));
  feed('{"a":1}\r\n{"b":2}\r\n');
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});

test('accepts Buffer chunks', () => {
  const out = [];
  const feed = createJsonlParser((m) => out.push(m));
  feed(Buffer.from('{"buf":true}\n'));
  assert.deepEqual(out, [{ buf: true }]);
});

test('handles multi-byte UTF-8 split across Buffer chunks', () => {
  const out = [];
  const feed = createJsonlParser((m) => out.push(m));
  const whole = Buffer.from('{"t":"한글"}\n');
  // split in the middle of a 3-byte Hangul character
  const splitAt = whole.indexOf(Buffer.from('한')) + 1;
  feed(whole.slice(0, splitAt));
  feed(whole.slice(splitAt));
  assert.deepEqual(out, [{ t: '한글' }]);
});
