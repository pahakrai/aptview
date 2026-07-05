import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { AuditsService } from './audits.service';
import { AuditsController } from './audits.controller';
import { AuditProcessor } from './audit.processor';
import { SandboxService } from './sandbox.service';

@Module({
  imports: [
    ConfigModule,
    BullModule.registerQueue({
      name: 'audits',
    }),
  ],
  controllers: [AuditsController],
  providers: [AuditsService, AuditProcessor, SandboxService],
  exports: [AuditsService, SandboxService],
})
export class AuditsModule {}
