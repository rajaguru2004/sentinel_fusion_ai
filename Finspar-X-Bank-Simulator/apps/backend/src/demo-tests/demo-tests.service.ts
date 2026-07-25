import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Subject } from 'rxjs';

/**
 * Spawns the Playwright demo suite on request, so a presenter can run each
 * watcher from a button on the login page and the jury can watch the result
 * stream in.
 *
 * SECURITY. This executes a process on behalf of an unauthenticated HTTP caller,
 * which is only acceptable because of three hard constraints, all enforced here:
 *
 *   1. The whole module is only registered when DEMO_TEST_RUNNER === 'true'
 *      (see demo-tests.module.ts). Off by default -> the routes do not exist.
 *   2. `spec` is looked up in SPEC_MAP. Anything not a key is rejected before
 *      anything is spawned. No caller-supplied path, flag, or grep expression is
 *      ever passed through.
 *   3. execFile with an argv ARRAY and shell:false — there is no shell, so no
 *      metacharacter in any input can be interpreted.
 *
 * It must never be enabled outside a demo machine.
 */

export const SPEC_MAP = {
  money: 'tests/specs/01-money-watcher.spec.ts',
  habits: 'tests/specs/02-habits-watcher.spec.ts',
  intrusion: 'tests/specs/03-intrusion-watcher.spec.ts',
  quantum: 'tests/specs/04-quantum-watcher.spec.ts',
  'command-center': 'tests/specs/05-command-center.spec.ts',
  all: null, // whole suite
} as const;

export type SpecId = keyof typeof SPEC_MAP;

export const SPEC_LABELS: Record<SpecId, string> = {
  money: 'Money Watcher',
  habits: 'Habits Watcher',
  intrusion: 'Intrusion Watcher',
  quantum: 'Future-Proofing Watcher',
  'command-center': 'Command Center',
  all: 'All watchers',
};

export type RunEvent =
  | { type: 'line'; text: string }
  | { type: 'status'; status: RunStatus }
  | { type: 'done'; status: RunStatus; exitCode: number | null; durationMs: number };

export type RunStatus = 'running' | 'passed' | 'failed' | 'cancelled' | 'timeout';

interface Run {
  id: string;
  spec: SpecId;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  exitCode: number | null;
  lines: string[];
  subject: Subject<RunEvent>;
  child?: ChildProcess;
  timer?: NodeJS.Timeout;
}

/** Wall-clock cap so a hung run can never pin the machine mid-presentation. */
const MAX_RUN_MS = 5 * 60_000;
/** Keep the log bounded — a runaway spec must not exhaust memory. */
const MAX_LINES = 2_000;

@Injectable()
export class DemoTestsService {
  private readonly log = new Logger(DemoTestsService.name);
  private readonly runs = new Map<string, Run>();
  private activeRunId: string | null = null;

  /**
   * Simulator root — the directory containing playwright.config.ts.
   *
   * Found by walking up rather than by counting `..` segments, because
   * __dirname differs between `nest start` (src/) and a built run (dist/src/),
   * so any fixed depth is wrong in one of the two modes.
   */
  private get simulatorRoot(): string {
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, 'playwright.config.ts'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new HttpException(
      'Could not locate playwright.config.ts above ' + __dirname,
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  listSpecs(): { id: SpecId; label: string }[] {
    return (Object.keys(SPEC_MAP) as SpecId[]).map((id) => ({ id, label: SPEC_LABELS[id] }));
  }

  start(spec: string): { runId: string } {
    if (!Object.prototype.hasOwnProperty.call(SPEC_MAP, spec)) {
      throw new HttpException(
        `Unknown spec "${spec}". Allowed: ${Object.keys(SPEC_MAP).join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const specId = spec as SpecId;

    // Single-run mutex. Playwright is configured workers:1 and the specs mutate
    // shared ledger + feature-store state; two concurrent runs would corrupt
    // each other and produce a confusing red run on stage.
    if (this.activeRunId) {
      const active = this.runs.get(this.activeRunId);
      throw new HttpException(
        `A run is already in progress (${active ? SPEC_LABELS[active.spec] : 'unknown'}). Wait for it to finish or cancel it.`,
        HttpStatus.CONFLICT,
      );
    }

    const file = SPEC_MAP[specId];
    // Fixed argv. Nothing from the request reaches this array except via the
    // SPEC_MAP lookup above, which can only yield a constant.
    const args = ['playwright', 'test', ...(file ? [file] : []), '--reporter=list'];

    const run: Run = {
      id: randomUUID(),
      spec: specId,
      status: 'running',
      startedAt: Date.now(),
      exitCode: null,
      lines: [],
      subject: new Subject<RunEvent>(),
    };
    this.runs.set(run.id, run);
    this.activeRunId = run.id;

    this.push(run, `$ npx ${args.join(' ')}`);
    this.push(run, `(cwd: ${this.simulatorRoot})`);

    const child = execFile('npx', args, {
      cwd: this.simulatorRoot,
      shell: false,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        CI: '1', // stable, non-interactive reporter output
        FORCE_COLOR: '0', // no ANSI escapes in the streamed log
        PW_RUN_ID: run.id,
      },
    });
    run.child = child;

    const onChunk = (buf: Buffer | string): void => {
      for (const line of String(buf).split('\n')) {
        if (line.trim().length) this.push(run, line);
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    run.timer = setTimeout(() => {
      if (run.status === 'running') {
        this.push(run, `--- timed out after ${MAX_RUN_MS / 1000}s, killing ---`);
        child.kill('SIGKILL');
        this.finish(run, 'timeout', null);
      }
    }, MAX_RUN_MS);

    child.on('error', (err) => {
      this.push(run, `Failed to launch Playwright: ${err.message}`);
      this.push(
        run,
        'Is Playwright installed at the simulator root? Run: npm install && npx playwright install chromium',
      );
      this.finish(run, 'failed', null);
    });

    child.on('close', (code) => {
      if (run.status !== 'running') return; // already cancelled/timed out
      this.finish(run, code === 0 ? 'passed' : 'failed', code);
    });

    this.log.log(`demo-test run ${run.id} started (${specId})`);
    return { runId: run.id };
  }

  cancel(runId: string): { cancelled: boolean } {
    const run = this.get(runId);
    if (run.status !== 'running') return { cancelled: false };
    run.child?.kill('SIGKILL');
    this.push(run, '--- cancelled by user ---');
    this.finish(run, 'cancelled', null);
    return { cancelled: true };
  }

  stream(runId: string): Subject<RunEvent> {
    return this.get(runId).subject;
  }

  /** Full state, for the initial paint and as a fallback when SSE is unavailable. */
  status(runId: string) {
    const run = this.get(runId);
    return {
      runId: run.id,
      spec: run.spec,
      label: SPEC_LABELS[run.spec],
      status: run.status,
      exitCode: run.exitCode,
      startedAt: new Date(run.startedAt).toISOString(),
      durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
      lines: run.lines,
    };
  }

  current(): { runId: string; spec: SpecId } | null {
    if (!this.activeRunId) return null;
    const run = this.runs.get(this.activeRunId);
    return run ? { runId: run.id, spec: run.spec } : null;
  }

  private get(runId: string): Run {
    const run = this.runs.get(runId);
    if (!run) throw new HttpException('Unknown runId', HttpStatus.NOT_FOUND);
    return run;
  }

  private push(run: Run, text: string): void {
    if (run.lines.length < MAX_LINES) {
      run.lines.push(text);
      run.subject.next({ type: 'line', text });
    } else if (run.lines.length === MAX_LINES) {
      run.lines.push('--- output truncated ---');
      run.subject.next({ type: 'line', text: '--- output truncated ---' });
    }
  }

  private finish(run: Run, status: RunStatus, exitCode: number | null): void {
    if (run.timer) clearTimeout(run.timer);
    run.status = status;
    run.exitCode = exitCode;
    run.endedAt = Date.now();
    run.subject.next({
      type: 'done',
      status,
      exitCode,
      durationMs: run.endedAt - run.startedAt,
    });
    run.subject.complete();
    if (this.activeRunId === run.id) this.activeRunId = null;
    this.log.log(`demo-test run ${run.id} ${status} (exit ${exitCode})`);

    // Keep only the last few runs in memory.
    if (this.runs.size > 10) {
      const oldest = [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
      if (oldest && oldest.status !== 'running') this.runs.delete(oldest.id);
    }
  }
}
