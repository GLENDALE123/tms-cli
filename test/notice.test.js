import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { showFirstRunNotice, serviceNotice } from '../src/notice.js';

test('첫 실행에 종료 안내를 한 번 보여 주고 동시 실행도 중복 표시를 막는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tms-notice-test-')); let output = '';
  try {
    await Promise.all(Array.from({ length: 4 }, () => showFirstRunNotice({ directory: dir, write: text => { output += text; } })));
    assert.equal(output.split('TMS 서비스 종료 안내').length - 1, 1);
    assert.match(output, /2026년 12월 31일/);
    assert.match(output, /6개월/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('안내 상태를 저장할 수 없어도 실행을 막지 않고 안내를 표시한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tms-notice-test-')); let output = '';
  try {
    const file = join(dir, 'file'); await writeFile(file, 'x');
    await showFirstRunNotice({ directory: join(file, 'not-a-dir'), write: text => { output += text; } });
    assert.match(output, /새 데이터 쓰기는 금지/);
    assert.ok(output.includes(serviceNotice));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
