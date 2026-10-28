import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = fileURLToPath(new URL('../bin/tms.js', import.meta.url));
const run = (directory, ...args) => promisify(execFile)(process.execPath, [cli, ...args], { env: { ...process.env, TMS_CLI_STATE_DIRECTORY: directory, TMS_CLI_DISABLE_NETWORK: '1' } });

test('이미 저장 경로가 있으면 로그인 저장소나 네트워크에 접근하기 전에 중단한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tms-cli-existing-'));
  try {
    const path = join(directory, 'existing.pdf');
    await writeFile(path, 'keep');
    for (const args of [['spec', '--id', 'fake', '--kind', 'product', '--output', path], ['image', '--inspection', 'fake', '--index', '1', '--output', path]]) {
      await assert.rejects(run(directory, ...args), error => error.code === 1 && /파일이 이미/.test(error.stderr) && !/비활성화|로그인이 필요/.test(error.stderr));
    }
    assert.equal(await readFile(path, 'utf8'), 'keep');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('명령 진단 시간은 전체 명령을 측정하고 인수나 입력값은 기록하지 않는다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tms-cli-timing-'));
  try {
    const result = await promisify(execFile)(process.execPath, [cli, 'query', '--help'], { env: { ...process.env, TMS_CLI_STATE_DIRECTORY: directory, TMS_CLI_DISABLE_NETWORK: '1', TMS_CLI_DIAGNOSTICS: '1' } });
    const event = JSON.parse(result.stderr.trim().split('\n').at(-1));
    assert.deepEqual(Object.keys(event).sort(), ['command', 'elapsedMs', 'event', 'success']);
    assert.equal(event.event, 'tms.command');
    assert.equal(event.command, 'query');
    assert.equal(event.success, true);
    assert.ok(Number.isInteger(event.elapsedMs) && event.elapsedMs >= 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('에이전트가 서버 연결 없이 명령별 JSON 예시와 생산시간 안내를 찾는다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tms-cli-help-'));
  try {
    const help = await run(directory, 'query', '--help');
    assert.match(help.stdout, /"source":"coating-schedule"/);
    assert.match(help.stdout, /ConvertTo-Json/);
    assert.match((await run(directory, 'plan', '--help')).stdout, /"steps"/);
    assert.match((await run(directory, 'image', '--help')).stdout, /--inspection/);
    const guide = await run(directory, 'guide');
    assert.match(guide.stdout, /startTime/);
    assert.match(guide.stdout, /inputQuantity/);
    assert.match(guide.stdout, /Scheduled reports and recurring queries/);
    assert.match(guide.stdout, /Windows Task Scheduler, macOS launchd, or Linux cron/);
    assert.match(guide.stdout, /Do not put passwords, Firebase tokens/);
    assert.match((await run(directory, '--help')).stdout, /예약 보고나 정기 조회/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('권한 경계를 우회하는 예전 직접 조회 명령은 인증 전에 중단', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tms-cli-guard-'));
  try {
    for (const args of [['firestore', 'query', 'users'], ['storage', 'list'], ['quality', 'images', '--order', 'T12345'], ['injection', 'inbound', '--date', '2026-10-27']]) {
      await assert.rejects(run(directory, ...args), error => error.code === 1 && /직접 조회는 권한 검증 문제로 중단/.test(error.stderr));
    }
    await assert.rejects(run(directory, 'retrieve', 'capabilities'), error => error.code === 1 && /색인 검색이 제거/.test(error.stderr));
    const imageArgs = ['--inspection', 'synthetic', '--index', '1', '--output', 'image.png'];
    await assert.rejects(run(directory, 'image', ...imageArgs), error => error.code === 1 && /비활성화/.test(error.stderr));
    await assert.rejects(run(directory, 'retrieve', 'image', ...imageArgs), error => error.code === 1 && /비활성화/.test(error.stderr));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI는 첫 실행 안내와 로컬 기준 저장·재조회·안전한 실행 거부를 연결한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tms-cli-criteria-'));
  const invoke = (args, input = '') => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, TMS_CLI_STATE_DIRECTORY: directory, TMS_CLI_DISABLE_NETWORK: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
  try {
    const template = { kind: 'query', request: { source: 'jig-requests', filters: [{ field: 'itemName', op: 'eq', value: { $param: 'name' } }], limit: 10 } };
    const saved = await invoke(['criteria', 'save', 'my-jig'], JSON.stringify(template));
    assert.equal(saved.code, 0);
    assert.match(saved.stderr, /2026년 12월 31일/);
    assert.deepEqual(JSON.parse(saved.stdout).parameters, ['name']);
    const listed = await invoke(['criteria', 'list']);
    assert.deepEqual(JSON.parse(listed.stdout).criteria, ['my-jig']);
    assert.doesNotMatch(listed.stderr, /서비스 종료 안내/);
    const shown = await invoke(['criteria', 'show', 'my-jig']);
    assert.deepEqual(JSON.parse(shown.stdout).template, template);
    const run = await invoke(['criteria', 'run', 'my-jig'], JSON.stringify({ name: '가상' }));
    assert.equal(run.code, 1);
    assert.match(run.stderr, /비활성화/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
