import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FlowRunnerService } from './flow-runner.service';

@Module({
  imports: [ConfigModule],
  providers: [FlowRunnerService],
  exports: [FlowRunnerService],
})
export class FlowRunnerModule {}
