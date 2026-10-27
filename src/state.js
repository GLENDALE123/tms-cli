import { homedir, platform } from 'node:os';
import { join, isAbsolute } from 'node:path';

export function stateDirectory(env = process.env, system = platform(), home = homedir()) {
  if (env.TMS_CLI_STATE_DIRECTORY && isAbsolute(env.TMS_CLI_STATE_DIRECTORY)) return env.TMS_CLI_STATE_DIRECTORY;
  if (system === 'win32') return join(env.LOCALAPPDATA && isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : join(home, 'AppData', 'Local'), 'tms-cli');
  if (system === 'darwin') return join(home, 'Library', 'Application Support', 'tms-cli');
  return join(env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, '.local', 'state'), 'tms-cli');
}
