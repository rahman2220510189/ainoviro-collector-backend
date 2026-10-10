/**
 * Runs the API server and the worker together in one service (hosting, step 7).
 * Render's free plan has no background workers, so the backend web service starts both:
 * the worker then runs whenever the service is awake. On a paid plan the same command
 * keeps both running around the clock; nothing else changes.
 *
 * Each runs in its own process, exactly as `npm start` and `npm run worker` do locally.
 * If either one stops, the other is stopped too and the whole service exits, so Render
 * restarts it cleanly instead of leaving half of it running.
 *
 *   node dist/all.js     (after npm run build)
 */
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const ext = path.extname(__filename); // ".js" after the build
const parts: Record<string, ChildProcess> = {
  server: fork(path.join(__dirname, `server${ext}`)),
  worker: fork(path.join(__dirname, `worker${ext}`)),
};

let stopping = false;
function stopAll(reason: string, code: number): void {
  if (stopping) return;
  stopping = true;
  console.log(`[all] ${reason}: stopping the server and the worker`);
  for (const child of Object.values(parts)) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  // Give both a moment to finish their current step, then leave.
  setTimeout(() => process.exit(code), 10_000).unref();
}

for (const [name, child] of Object.entries(parts)) {
  child.on('exit', (code, signal) => {
    if (Object.values(parts).every((c) => c.exitCode !== null || c.signalCode !== null)) {
      process.exit(stopping ? 0 : (code ?? 1));
    }
    stopAll(`the ${name} stopped (${signal ?? `code ${code}`})`, code ?? 1);
  });
}

process.on('SIGTERM', () => stopAll('SIGTERM', 0));
process.on('SIGINT', () => stopAll('SIGINT', 0));
