import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDirectory } from './state.js';

export const serviceNotice = `TMS 서비스 종료 안내
TMS 서비스는 2026년 12월 31일 종료할 예정입니다.
새 데이터 쓰기는 금지되며, 기존 데이터 읽기는 서비스 종료 후 6개월간 제공될 예정입니다.`;

// Installation output is not consistently shown by npm/npx. The first command
// also displays the notice on stderr, without corrupting JSON stdout.
export async function showFirstRunNotice({ directory = stateDirectory(), write = text => process.stderr.write(text) } = {}) {
  let file;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    file = await open(join(directory, 'service-notice-2026-12-31.seen'), 'wx', 0o600);
    await file.close();
    write(`${serviceNotice}\n\n`);
  } catch (error) {
    if (error?.code !== 'EEXIST') write(`${serviceNotice}\n\n`);
  }
}
