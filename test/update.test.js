import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { updateCli } from '../src/update.js';

test('Windows와 Unix에서 고정된 npm 전역 업데이트만 호출한다', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    let called;
    await updateCli({ platform, start: (command, args, options) => {
      called = { command, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    } });
    assert.ok(called.args.includes('@hs-jig/tms-cli@latest'));
    assert.ok(called.args.includes('--global'));
    assert.equal(called.options.shell, false);
    if (platform === 'win32') assert.deepEqual(called.args.slice(0, 4), ['/d', '/s', '/c', 'npm.cmd']);
    else assert.equal(called.command, 'npm');
  }
});

test('npm 실행 실패나 0이 아닌 종료는 업데이트 실패로 전달한다', async () => {
  const create = (event, ...args) => () => { const child = new EventEmitter(); queueMicrotask(() => child.emit(event, ...args)); return child; };
  await assert.rejects(updateCli({ start: create('error', new Error('missing npm')) }), /npm을 실행할 수 없습니다/);
  await assert.rejects(updateCli({ start: create('close', 1, null) }), /업데이트에 실패/);
});
