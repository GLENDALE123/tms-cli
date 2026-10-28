import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { retrievalEndpoint } from './retrieval.js';
import { request } from './http.js';
import { inspectIdToken } from './auth-source.js';
import { saveSession } from './session-store.js';
import { openBrowser } from './login.js';

const hash = (value) => createHash('sha256').update(value).digest('base64url');
const jwk = (key) => ({ kty: key.kty, crv: key.crv, x: key.x, y: key.y });
export async function createDeviceKeys() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveKey',
  ]);
  return {
    privateKey: pair.privateKey,
    publicKey: jwk(await webcrypto.subtle.exportKey('jwk', pair.publicKey)),
  };
}
export async function decryptDeviceSession(keys, flow, receipt, now = Date.now()) {
  const envelope = receipt?.envelope;
  if (
    !envelope ||
    typeof envelope.ciphertext !== 'string' ||
    envelope.ciphertext.length > 16384 ||
    typeof envelope.iv !== 'string' ||
    !/^[A-Za-z0-9_-]{16}$/.test(envelope.iv)
  )
    throw Error('로그인 암호화 응답이 올바르지 않습니다.');
  let payload;
  try {
    const peer = await webcrypto.subtle.importKey(
      'jwk',
      envelope.publicKey,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const key = await webcrypto.subtle.deriveKey(
      { name: 'ECDH', public: peer },
      keys.privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const plaintext = await webcrypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: Buffer.from(envelope.iv, 'base64url'),
        additionalData: Buffer.from('tms-cli-device-v1|' + flow.deviceId + '|' + flow.userCode),
      },
      key,
      Buffer.from(envelope.ciphertext, 'base64url'),
    );
    payload = JSON.parse(Buffer.from(plaintext).toString());
  } catch {
    throw Error('로그인 결과를 복호화하지 못했습니다. CLI에서 다시 로그인하세요.');
  }
  const claims = inspectIdToken(payload.idToken, { now });
  if (
    payload.version !== 1 ||
    payload.deviceId !== flow.deviceId ||
    claims.uid !== receipt.uid ||
    payload.uid !== receipt.uid ||
    hash(payload.idToken) !== receipt.idTokenHash ||
    typeof payload.refreshToken !== 'string' ||
    !payload.refreshToken ||
    payload.refreshToken.length > 8192
  )
    throw Error('로그인 계정 또는 요청이 일치하지 않습니다.');
  return {
    uid: claims.uid,
    email: claims.email ?? '',
    refreshToken: payload.refreshToken,
    idToken: payload.idToken,
    idTokenIssuedAt: claims.issuedAt,
    idTokenExpiresAt: claims.expiresAt,
  };
}

export async function deviceLogin({
  send,
  save = saveSession,
  launch = openBrowser,
  write = (text) => process.stderr.write(text),
  wait = sleep,
  now = Date.now,
  timeoutMs = 300000,
} = {}) {
  const target = new URL(retrievalEndpoint()),
    base = target.pathname.replace(/\/search$/, '/login/');
  const post =
    send ??
    (async (action, body, signal) => {
      const url = new URL(target);
      url.pathname = base + action;
      const response = await request(url.toString(), {
        retryConnect: true,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      return response.json();
    });
  const keys = await createDeviceKeys(),
    verifier = randomBytes(32).toString('base64url');
  let flow,
    stored = false;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    flow = await post('start', { publicKey: keys.publicKey, challenge: hash(verifier) }, signal);
    const uri = new URL(flow.verificationUri);
    if (
      uri.origin !== target.origin ||
      uri.pathname !== '/tms/login' ||
      uri.search ||
      !/^[A-Za-z0-9_-]{24}$/.test(flow.deviceId) ||
      !/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(flow.userCode) ||
      !Number.isInteger(flow.expiresIn) ||
      flow.expiresIn < 1 ||
      flow.expiresIn > 300 ||
      new URLSearchParams(uri.hash.slice(1)).get('id') !== flow.deviceId ||
      !/^[A-Za-z0-9_-]{43}$/.test(new URLSearchParams(uri.hash.slice(1)).get('code') ?? '')
    )
      throw Error('신뢰할 수 있는 브라우저 로그인 응답이 아닙니다.');
    write(
      '브라우저에서 TMS 계정으로 로그인하고 아래 코드를 확인하세요.\n코드: ' +
        flow.userCode +
        '\n' +
        uri.toString() +
        '\n',
    );
    launch(uri.toString());
    const expires = now() + Math.min(timeoutMs, flow.expiresIn * 1000);
    let interval = 2;
    for (;;) {
      await wait(interval * 1000, undefined, { signal });
      if (now() >= expires || signal.aborted)
        throw Error('브라우저 로그인 시간이 만료됐습니다. 다시 로그인하세요.');
      const result = await post('poll', { deviceId: flow.deviceId, verifier }, signal);
      if (result.status === 'pending') {
        interval = result.interval === 4 ? 4 : 2;
        continue;
      }
      if (result.status !== 'complete') throw Error('브라우저 로그인을 완료하지 못했습니다.');
      const session = await decryptDeviceSession(keys, flow, result, now());
      await save(session);
      stored = true;
      await post('ack', { deviceId: flow.deviceId, verifier }, AbortSignal.timeout(5000)).catch(
        () => {},
      );
      return { uid: session.uid, email: session.email };
    }
  } catch (error) {
    if (signal.aborted) throw Error('브라우저 로그인 시간이 만료됐습니다. 다시 로그인하세요.');
    throw error;
  } finally {
    if (flow && !stored)
      await post('cancel', { deviceId: flow.deviceId, verifier }, AbortSignal.timeout(3000)).catch(
        () => {},
      );
  }
}
