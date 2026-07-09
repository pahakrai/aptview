import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { LogAnalyzerService } from './log-analyzer.service';
import { LogAnalyzerController } from './log-analyzer.controller';
import { LogAnalyzerProcessor } from './log-analyzer.processor';

@Module({
  imports: [
    ConfigModule,
    BullModule.registerQueue({
      name: 'log-analyzer',
    }),
  ],
  controllers: [LogAnalyzerController],
  providers: [LogAnalyzerService, LogAnalyzerProcessor],
  exports: [LogAnalyzerService],
})
export class LogAnalyzerModule {}
