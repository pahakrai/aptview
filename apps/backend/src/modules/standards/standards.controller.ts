import {
  Controller, Get, Post, Patch, Delete, Param, Body, Query,
  UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { StandardsService } from './standards.service';

@Controller('standards')
export class StandardsController {
  constructor(private readonly standardsService: StandardsService) {}

  /**
   * Upload a PDF or text file containing coding standards.
   * Extracts text and parses it into guideline patterns.
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadStandards(
    @UploadedFile() file: Express.Multer.File,
    @Body('organizationId') organizationId: string,
  ) {
    return this.standardsService.parseUploadedStandards(file, organizationId);
  }

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
