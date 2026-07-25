import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { throttlerOptions } from './common/throttler.config';
import { CorrelationIdInterceptor } from './common/correlation-id.interceptor';
import { CsrfGuard } from './common/csrf';
import { PrismaModule } from './prisma/prisma.module';
import { MailerModule } from './mailer/mailer.module';
import { OtpModule } from './otp/otp.module';
import { AuthModule } from './auth/auth.module';
import { RecoveryModule } from './recovery/recovery.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AccountsModule } from './accounts/accounts.module';
import { BeneficiariesModule } from './beneficiaries/beneficiaries.module';
import { FraudModule } from './fraud/fraud.module';
import { PaymentsModule } from './payments/payments.module';
import { DisputesModule } from './disputes/disputes.module';
import { AnalystModule } from './analyst/analyst.module';
import { SentinelModule } from './sentinel/sentinel.module';
import { DemoTestsModule } from './demo-tests/demo-tests.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    // Request-level rate limiting (§2). Tier definitions and storage choice live
    // in common/throttler.config.ts; routes opt into a tier with @Throttle.
    ThrottlerModule.forRoot(throttlerOptions()),
    PrismaModule,
    MailerModule,
    OtpModule,
    AuthModule,
    RecoveryModule,
    DashboardModule,
    AccountsModule,
    BeneficiariesModule,
    FraudModule,
    PaymentsModule,
    DisputesModule,
    AnalystModule,
    // Browser-facing proxy to the model — the Sentinel Console needs it because
    // the FastAPI service mounts no CORS middleware.
    SentinelModule,
    // Playwright runner for the login-page demo panel. Only mounts when
    // DEMO_TEST_RUNNER=true; otherwise this contributes no routes at all.
    DemoTestsModule.register(),
  ],
  controllers: [AppController],
  providers: [
    // Rate limiting applies to every route by default; @Throttle picks a tighter
    // tier, @SkipThrottle opts out (the SSE stream holds one long connection).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Double-submit CSRF check on every state-changing request (§4). Runs after
    // the throttler so a flood is rejected before it reaches the token compare.
    { provide: APP_GUARD, useClass: CsrfGuard },
    // Assigns/propagates the correlation id that ties a request together across
    // Next.js -> NestJS -> Sentinel (§3).
    { provide: APP_INTERCEPTOR, useClass: CorrelationIdInterceptor },
  ],
})
export class AppModule {}
