import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { FlowRunnerModule } from '../flow-runner/flow-runner.module';
import { ExperimentsService } from './experiments.service';
import { ExperimentsController } from './experiments.controller';
import { BenchmarksProcessor } from './benchmarks.processor';
import { PromotionsService } from './promotions.service';
import { NotificationsService } from './notifications.service';
import { EvalService } from './eval.service';

@Module({
  imports: [
    ConfigModule,
    FlowRunnerModule,
    BullModule.registerQueue({ name: 'benchmarks' }),
  ],
  controllers: [ExperimentsController],
  providers: [
    ExperimentsService,
    BenchmarksProcessor,
    PromotionsService,
    NotificationsService,
    EvalService,
  ],
  exports: [ExperimentsService, PromotionsService, NotificationsService, EvalService],
})
export class ExperimentsModule {}
