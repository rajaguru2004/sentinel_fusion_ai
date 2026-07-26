import { Global, Module } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';

/**
 * Global: the fraud gateway, the alert mailer, payments and the ledger all read
 * policy from here. Making it global keeps those four from having to import a
 * settings module apiece — the same reasoning PrismaModule and FraudModule use.
 */
@Global()
@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
