import { DynamicModule, Logger, Module } from '@nestjs/common';
import { env } from '../common/env';
import { DemoTestsController } from './demo-tests.controller';
import { DemoTestsService } from './demo-tests.service';

/**
 * Registers the Playwright runner ONLY when DEMO_TEST_RUNNER=true.
 *
 * `register()` returning an empty module means that with the flag off the
 * controller is never mounted at all, so /api/demo-tests/* 404s — the routes do
 * not exist rather than existing-but-refusing. That is the behaviour you want
 * for something that spawns processes for unauthenticated callers.
 */
@Module({})
export class DemoTestsModule {
  static register(): DynamicModule {
    if (!env.demo.testRunnerEnabled) {
      return { module: DemoTestsModule };
    }
    new Logger('DemoTestsModule').warn(
      'DEMO_TEST_RUNNER=true — /api/demo-tests/* is mounted and UNAUTHENTICATED. Demo machines only.',
    );
    return {
      module: DemoTestsModule,
      controllers: [DemoTestsController],
      providers: [DemoTestsService],
    };
  }
}
