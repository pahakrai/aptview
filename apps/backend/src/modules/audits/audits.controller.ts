import { Controller, Get, Post, Param, Body, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuditsService } from './audits.service';
import { AuditRequest } from '@aigov/shared-types';

@Controller('audits')
export class AuditsController {
  constructor(private readonly auditsService: AuditsService) {}

  @Post()
  @UseGuards(AuthGuard('api-key'))
  async triggerAudit(@Body() body: AuditRequest) {
    return this.auditsService.enqueueAudit(body);
  }

  @Get('repo/:repoId')
  async listByRepo(
    @Param('repoId') repoId: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    return this.auditsService.listByRepo(repoId, +page, +pageSize);
  }

  /**
   * Get score trends over time (weekly averages).
   * Must be defined before `:id` routes to avoid route conflicts.
   */
  @Get('org/:orgId/score-trends')
  async getScoreTrends(
    @Param('orgId') orgId: string,
    @Query('weeks') weeks = '12',
  ) {
    return this.auditsService.getScoreTrends(orgId, +weeks);
  }

  @Get('org/:orgId/stats')
  async getOrgStats(@Param('orgId') orgId: string) {
    return this.auditsService.getOrgStats(orgId);
  }

  /**
   * Get the latest audit scores for a specific PR in a repository.
   */
  @Get('by-pr/:repoId/:prNumber')
  async getByPr(
    @Param('repoId') repoId: string,
    @Param('prNumber') prNumber: string,
  ) {
    return this.auditsService.getByPr(repoId, +prNumber);
  }

  /**
   * Get the three percentage scores for a specific audit.
   */
  @Get(':id/scores')
  async getScores(@Param('id') id: string) {
    return this.auditsService.getScores(id);
  }

  @Get(':id/violations')
  async getViolations(@Param('id') id: string) {
    return this.auditsService.getViolations(id);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.auditsService.getById(id);
  }
}
