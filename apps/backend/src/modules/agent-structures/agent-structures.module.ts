import { Module } from '@nestjs/common';
import { AgentStructuresService } from './agent-structures.service';
import { AgentStructuresController } from './agent-structures.controller';

@Module({
  providers: [AgentStructuresService],
  controllers: [AgentStructuresController],
  exports: [AgentStructuresService],
})
export class AgentStructuresModule {}
