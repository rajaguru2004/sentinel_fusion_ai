import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
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
  providers: [],
})
export class AppModule {}
