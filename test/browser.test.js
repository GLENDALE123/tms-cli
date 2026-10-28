import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../src/browser.js', import.meta.url), 'utf8');
async function simulate(reply) {
  let handler;
  const fields = { email: { value: 'someone@example.test' }, password: { value: 'fake-password' } };
  const button = { disabled: false }, status = { textContent: '' };
  const form = { hidden: false, elements: { namedItem: key => fields[key] }, querySelector: () => button, addEventListener: (_type, callback) => { handler = callback; } };
  const document = { body: { dataset: { apiKey: 'fake' } }, querySelector: selector => selector === 'form' ? form : status };
  runInNewContext(source, { document, location: { hash: `#${'a'.repeat(64)}` }, history: { replaceState() {} }, fetch: async () => { if (reply instanceof Error) throw reply; return { ok: reply.ok, json: async () => reply.data }; }, encodeURIComponent });
  await handler({ preventDefault() {}, currentTarget: form });
  assert.equal(fields.password.value, '');
  assert.equal(button.disabled, false);
  return status.textContent;
}

test('Firebase 인증 실패, 키 제한, 추가 인증과 네트워크 실패를 구분하고 비밀번호를 비운다', async () => {
  assert.match(await simulate({ ok: false, data: { error: { message: 'INVALID_LOGIN_CREDENTIALS' } } }), /이메일 또는 비밀번호/);
  assert.match(await simulate({ ok: false, data: { error: { message: 'API_KEY_HTTP_REFERRER_BLOCKED' } } }), /API 키/);
  assert.match(await simulate({ ok: true, data: { mfaPendingCredential: 'fake' } }), /추가 인증/);
  assert.match(await simulate(new Error('network')), /연결하지 못했습니다/);
});
