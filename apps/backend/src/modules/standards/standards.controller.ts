import { Controller, Get, Post, Patch, Delete, Param, Body, Query } from '@nestjs/common';
import { StandardsService } from './standards.service';

@Controller('standards')
export class StandardsController {
  constructor(private readonly standardsService: StandardsService) {}

  @Post()
  create(
    @Body()
    body: {
      organizationId: string;
      name: string;
      description?: string;
      pattern: string;
      severity?: string;
      category?: string;
    },
  ) {
    return this.standardsService.create(body);
  }

  @Get('org/:orgId')
  listByOrg(@Param('orgId') orgId: string) {
    return this.standardsService.listByOrg(orgId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.standardsService.getById(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.standardsService.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.standardsService.remove(id);
  }

  @Get('org/:orgId/context')
  async getContextMarkdown(@Param('orgId') orgId: string) {
    return this.standardsService.getContextMarkdown(orgId);
  }

  @Get('org/:orgId/violations/top')
  async getTopViolations(
    @Param('orgId') orgId: string,
    @Query('days') days = '30',
  ) {
    return this.standardsService.getTopViolations(orgId, +days);
  }
}
