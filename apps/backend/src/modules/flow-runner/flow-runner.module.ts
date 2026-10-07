import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FlowRunnerService } from './flow-runner.service';
import { ToolCatalogController } from './tool-catalog.controller';
import { McpDiscoveryController } from './mcp-discovery.controller';

@Module({
  imports: [ConfigModule],
  controllers: [ToolCatalogController, McpDiscoveryController],
  providers: [FlowRunnerService],
  exports: [FlowRunnerService],
})
export class FlowRunnerModule {}
