import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const action = args[0];
const index = args.indexOf('--profile');
const profile = index >= 0 ? args[index + 1] : null;
if (!['nas', 'windows'].includes(profile) || !['start', 'status'].includes(action)) {
  throw new Error('Usage: node scripts/runtime.js start|status --profile nas|windows [--config file] [--dry-run]');
}
const configIndex = args.indexOf('--config');
if (configIndex >= 0 && (!args[configIndex + 1] || args[configIndex + 1].startsWith('--'))) throw new Error('--config requires a file');
if (profile === 'nas' && configIndex >= 0) throw new Error('NAS uses deploy/nas-compose.yml and the mounted workspace config');
const config = configIndex >= 0 ? ['--config', path.resolve(args[configIndex + 1])] : [];
const qnapDocker = '/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker';
const dockerCommand = process.env.WEBJJONKU_DOCKER_BIN || (fs.existsSync(qnapDocker) ? qnapDocker : 'docker');
const env = { ...process.env, WEBJJONKU_RUNTIME_PROFILE: profile };

function commandWorks(command, commandArgs) {
  const r = spawnSync(command, commandArgs, { cwd: root, env, windowsHide: true, stdio: 'ignore', timeout: 5000 });
  return !r.error && r.status === 0;
}
function composeRunner() {
  if (commandWorks(dockerCommand, ['compose', 'version'])) return { command: dockerCommand, prefix: ['compose'], available: true };
  return { command: dockerCommand, prefix: ['compose'], available: false };
}

function findWindowsLauncherPids(mode) {
  const script = `@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine -match 'nas-client-launcher\\.js.*--mode\\s+${mode}' } | ForEach-Object { $_.ProcessId }) -join ','`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 5000
  });
  if (result.error || result.status !== 0) return [];
    const text = String(result.stdout || '').trim();
    if (!text) return [];
    return text.split(',').map(Number).filter(pid => Number.isInteger(pid) && pid > 0);
}

if (profile === 'windows' && action === 'start') {
  const runtimeConfigPath = configIndex >= 0
    ? path.resolve(args[configIndex + 1])
    : path.join(root, '.webjjonku', 'nas-runtime.json');
  if (!fs.existsSync(runtimeConfigPath) && !args.includes('--dry-run')) throw new Error(`Windows auxiliary runtime config not found: ${runtimeConfigPath}`);
  const launcher = path.join(root, 'scripts', 'nas-client-launcher.js');
  const launches = ['daemon', 'browser', 'tools'].map(mode => ({
    mode,
    command: process.execPath,
    args: [launcher, '--mode', mode, '--config', runtimeConfigPath]
  }));

  if (args.includes('--dry-run')) {
    console.log(JSON.stringify({ profile, action, role: 'auxiliary', launches }, null, 2));
  } else {
    const result = [];
    for (const launch of launches) {
      const existing = findWindowsLauncherPids(launch.mode);
      for (const extra of existing.slice(1)) {
        spawnSync('taskkill.exe', ['/PID', String(extra), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
      }
      if (existing.length > 0) {
        result.push({ mode: launch.mode, pid: existing[0], action: 'kept' });
        continue;
      }
      const child = spawn(launch.command, launch.args, { cwd: root, env, detached: true, windowsHide: true, stdio: 'ignore' });
      child.once('error', error => { console.error(error.message); process.exitCode = 1; });
      child.unref();
      result.push({ mode: launch.mode, pid: child.pid, action: 'launched' });
    }
    console.log(JSON.stringify({ profile: 'windows', role: 'auxiliary', workers: result }, null, 2));
  }
} else {
  const compose = profile === 'nas' ? composeRunner() : null;
  const composeFile = path.join(root, 'deploy/nas-compose.yml');
  const envFile = path.join(root, 'deploy/.env');
  const command = profile === 'nas' ? compose.command : process.execPath;
  const composeBase = profile === 'nas'
    ? [
        ...compose.prefix,
        ...(fs.existsSync(envFile) ? ['--env-file', envFile] : []),
        '-f', composeFile,
        '--profile', 'tailscale'
      ]
    : [];
  const commands = profile === 'nas'
    ? (action === 'start'
      ? [
          [...composeBase, 'build', 'coordinator', 'connector', 'browser-nas'],
          [...composeBase, 'up', '-d', '--no-build', 'coordinator', 'connector', 'browser-nas', 'tailscale']
        ]
      : [[...composeBase, 'ps']])
    : [[path.join(root, 'scripts', 'status.js'), ...config]];

  if (args.includes('--dry-run')) {
    console.log(JSON.stringify({ profile, action, command, commands, composeAvailable: compose?.available ?? null }, null, 2));
    process.exit(0);
  }
  if (profile === 'nas' && !compose.available) {
    throw new Error('Docker Compose v2 is unavailable. Mount the QNAP docker-compose CLI plugin into the connector container.');
  }

  for (const childArgs of commands) {
    const result = spawnSync(command, childArgs, { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    if (result.error) {
      console.error(result.error.message);
      process.exitCode = 1;
      break;
    }
    if ((result.status ?? 1) !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
    process.exitCode = 0;
  }
}
