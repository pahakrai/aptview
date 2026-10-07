import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FlowRunnerService } from './flow-runner.service';
import { ToolCatalogController } from './tool-catalog.controller';

@Module({
  imports: [ConfigModule],
  controllers: [ToolCatalogController],
  providers: [FlowRunnerService],
  exports: [FlowRunnerService],
})
export class FlowRunnerModule {}
