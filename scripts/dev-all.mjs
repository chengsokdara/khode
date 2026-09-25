// One-terminal dev runner: `npm run dev` (alias `npm run dev:all`).
// Builds the admin SPA once if missing, then spawns `wrangler dev` (worker,
// :8787) and `vite` (admin UI, :5173) side by side with zero dependencies.
// Deliberate design points:
//   - Logs are NOT buried: every output line is prefixed with the server that
//     produced it (`worker` / `ui`) and relayed live, so both servers stay
//     readable in one terminal.
//   - Ctrl-C (SIGINT) stops BOTH children and waits for them to exit before
//     the runner quits — no orphaned wrangler/vite processes left behind.
//   - If either child dies on its own, the runner stops the other one too and
//     exits with that child's code (fail-fast; no half-running dev setup).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const CHILDREN = [
  // --test-scheduled exposes /__scheduled for firing the free-models sync cron
  // locally: curl "http://localhost:8787/__scheduled?cron=17+3+*+*+*"
  { tag: 'worker', cmd: 'npx', args: ['wrangler', 'dev', '--port', '8787', '--test-scheduled'], color: '\x1b[36m' }, // cyan
  { tag: 'ui', cmd: 'npx', args: ['vite'], color: '\x1b[35m' }, // magenta
];
const RESET = '\x1b[0m';
const RED = '\x1b[31m';

// First-run safety: wrangler needs web-dist/ to satisfy the ASSETS binding.
// Fresh clones have none — build it once (cached afterwards; UI dev on :5173
// uses vite's own transform anyway, and `npm run build:web` refreshes it).
if (!existsSync(new URL('../web-dist/index.html', import.meta.url))) {
  console.log('[dev] web-dist/ missing — building the admin SPA once (npm run build:web)…');
  const build = spawnSync('npx', ['vite', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

let shuttingDown = false;
const procs = [];

function pipe(child, tag, color) {
  const forward = (chunk) => {
    // Tag every line; a trailing partial line is flushed when completed.
    for (const line of String(chunk).split('\n')) {
      if (line === '') continue;
      process.stdout.write(`${color}[${tag}]${RESET} ${line}\n`);
    }
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);
}

function stopAll(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) {
    if (p.exitCode === null && p.signalCode === null) p.kill(signal);
  }
}

for (const { tag, cmd, args, color } of CHILDREN) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  procs.push(child);
  pipe(child, tag, color);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    // One server died on its own — bring the whole setup down (fail-fast).
    process.stderr.write(`${RED}[dev:all] '${tag}' exited (code=${code} signal=${signal}) — stopping everything${RESET}\n`);
    stopAll();
    process.exitCode = code ?? 1;
  });
}

// Ctrl-C in the terminal: first SIGINT also lands on the children (same process
// group) — stopAll is the safety net for any survivor, then we wait.
process.on('SIGINT', () => {
  process.stderr.write('\n\x1b[31m[dev:all] stopping both servers…\x1b[0m\n');
  stopAll();
});
process.on('SIGTERM', () => stopAll());

// Keep the runner alive until both children have exited.
const drained = () => procs.every((p) => p.exitCode !== null || p.signalCode !== null);
setInterval(() => {
  if (shuttingDown && drained()) process.exit();
}, 100);

process.on('exit', () => stopAll());
