import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { DecompositionService } from './decomposition.service';
import { DecompositionController } from './decomposition.controller';
import { DecompositionProcessor } from './decomposition.processor';
import { AuditsModule } from '../audits/audits.module';

@Module({
  imports: [
    ConfigModule,
    BullModule.registerQueue({
      name: 'decomposition',
    }),
    AuditsModule,
  ],
  controllers: [DecompositionController],
  providers: [DecompositionService, DecompositionProcessor],
  exports: [DecompositionService],
})
export class DecompositionModule {}
