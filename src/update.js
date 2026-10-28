import { spawn } from 'node:child_process';

// Only the public package name is fixed here. Never accept arbitrary shell text.
export async function updateCli({ platform = process.platform, start = spawn } = {}) {
  const args = ['install', '--global', '@hs-jig/tms-cli@latest', '--no-audit', '--no-fund'];
  const command = platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm';
  const commandArgs = platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd', ...args] : args;
  return await new Promise((resolve, reject) => {
    let child;
    try { child = start(command, commandArgs, { stdio: 'inherit', windowsHide: true, shell: false }); }
    catch { reject(new Error('npm을 실행할 수 없습니다. Node.js와 npm 설치 및 PATH를 확인하세요.')); return; }
    child.once('error', () => reject(new Error('npm을 실행할 수 없습니다. Node.js와 npm 설치 및 PATH를 확인하세요.')));
    child.once('close', (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error('업데이트에 실패했습니다. 위 npm 오류와 전역 설치 권한을 확인하세요.'));
    });
  });
}
