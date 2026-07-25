import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SentinelService } from './sentinel.service';

/**
 * Same-origin surface for the Sentinel Console (`/sentinel` in the UI).
 *
 * Unauthenticated on purpose: the console is a demo/inspection screen and the
 * routes are read-only with respect to the bank — nothing here can move money,
 * mutate an account, or write a FraudEvent. It only forwards a synthetic event
 * to the model and returns the verdict.
 */
@ApiTags('sentinel')
@Controller('sentinel')
export class SentinelController {
  constructor(private readonly sentinel: SentinelService) {}

  /**
   * `@Body()` is typed as an index signature on purpose. Nest's global
   * ValidationPipe runs with `whitelist: true, forbidNonWhitelisted: true`; a
   * DTO class here would strip or 400 every domain-specific field
   * (`bytes_out`, `q_data_class`, …). Typing the param as a plain object emits
   * `Object` as the design-time type, which the pipe skips, so the body reaches
   * the model intact. Validation is done explicitly in the service instead.
   */
  @Post('score')
  score(@Body() event: Record<string, unknown>) {
    return this.sentinel.score(event);
  }

  @Get('ready')
  ready() {
    return this.sentinel.ready();
  }

  @Get('metrics')
  metrics() {
    return this.sentinel.metrics();
  }
}
