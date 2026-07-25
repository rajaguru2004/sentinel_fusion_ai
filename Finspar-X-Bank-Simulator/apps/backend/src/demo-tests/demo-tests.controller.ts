import { Body, Controller, Get, Param, Post, Sse } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { map, type Observable } from 'rxjs';
import { DemoTestsService, type RunEvent } from './demo-tests.service';

/**
 * Demo test runner, driven by the panel on the login page.
 *
 * Unauthenticated by design: the buttons live on `/login` (pre-auth), and
 * EventSource cannot send an Authorization header. The protection is therefore
 * the DEMO_TEST_RUNNER flag + the SPEC_MAP allowlist + argv-array exec, all in
 * demo-tests.service.ts — not a guard here.
 */
@ApiTags('demo-tests')
@Controller('demo-tests')
export class DemoTestsController {
  constructor(private readonly runner: DemoTestsService) {}

  /** Which buttons the panel should render. */
  @Get('specs')
  specs() {
    return { specs: this.runner.listSpecs(), current: this.runner.current() };
  }

  @Post('run')
  run(@Body() body: { spec?: string }) {
    return this.runner.start(String(body?.spec ?? ''));
  }

  @Post('cancel/:runId')
  cancel(@Param('runId') runId: string) {
    return this.runner.cancel(runId);
  }

  @Get('status/:runId')
  status(@Param('runId') runId: string) {
    return this.runner.status(runId);
  }

  /** Live stdout/stderr of a run, one SSE message per event. */
  @Sse('stream/:runId')
  stream(@Param('runId') runId: string): Observable<{ data: RunEvent }> {
    return this.runner.stream(runId).pipe(map((event) => ({ data: event })));
  }
}
