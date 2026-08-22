import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { AuditsService } from './audits.service';
import { AuditsController } from './audits.controller';
import { AuditProcessor } from './audit.processor';
import { SandboxService } from './sandbox.service';
import { ExperimentsModule } from '../experiments/experiments.module';
import { FlowRunnerModule } from '../flow-runner/flow-runner.module';

@Module({
  imports: [
    ConfigModule,
    BullModule.registerQueue({
      name: 'audits',
    }),
    ExperimentsModule,
    FlowRunnerModule,
  ],
  controllers: [AuditsController],
  providers: [AuditsService, AuditProcessor, SandboxService],
  exports: [AuditsService, SandboxService],
})
export class AuditsModule {}
