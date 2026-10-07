import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AgentStructuresService } from './agent-structures.service';
import type { AuditStrategy } from '@aigov/shared-types';

@Controller('agent-structures')
export class AgentStructuresController {
  constructor(private readonly service: AgentStructuresService) {}

  @Get()
  async list(@Query('organizationId') organizationId?: string) {
    return this.service.list(organizationId ?? null);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.service.getById(id);
  }

  @Post()
  @UseGuards(AuthGuard('api-key'))
  async create(
    @Body() body: { name: string; description?: string | null; organizationId?: string | null; strategy: AuditStrategy },
  ) {
    return this.service.create(body);
  }

  @Patch(':id')
  @UseGuards(AuthGuard('api-key'))
  async update(
    @Param('id') id: string,
    @Body() body: { name?: string; description?: string | null; strategy?: AuditStrategy; isActive?: boolean },
  ) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  @UseGuards(AuthGuard('api-key'))
  async remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
