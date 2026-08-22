import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ExperimentsService } from './experiments.service';
import { PromotionsService } from './promotions.service';
import { NotificationsService } from './notifications.service';
import type {
  AuditStrategy,
  ExperimentStatus,
  MetricsWeights,
} from '@aigov/shared-types';

@Controller('experiments')
export class ExperimentsController {
  constructor(
    private readonly experimentsService: ExperimentsService,
    private readonly promotionsService: PromotionsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  @Get()
  async list() {
    return this.experimentsService.list();
  }

  @Get(':id/report')
  async report(@Param('id') id: string) {
    return this.experimentsService.getReport(id);
  }

  @Get(':id/benchmark')
  async benchmarkReport(@Param('id') id: string) {
    return this.experimentsService.getBenchmarkReport(id);
  }

  @Get(':id/benchmark-jobs')
  async listBenchmarkJobs(@Param('id') id: string) {
    return this.experimentsService.listBenchmarkJobs(id);
  }

  // NOTE: static one-segment routes are declared before @Get(':id') so they
  // win the route match over the dynamic segment.
  @Get('notifications')
  async listNotifications(@Query('organizationId') organizationId?: string) {
    return this.notificationsService.list(organizationId ?? null);
  }

  @Get('active-flows')
  async listActiveFlows() {
    return this.promotionsService.listActiveFlows();
  }

  @Get('active-flows/:id/runs')
  async listActiveFlowRuns(@Param('id') id: string) {
    return this.promotionsService.listActiveFlowRuns(id);
  }

  @Get('benchmark-jobs/:id')
  async getBenchmarkJob(@Param('id') id: string) {
    return this.experimentsService.getBenchmarkJob(id);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.experimentsService.getById(id);
  }

  @Post()
  @UseGuards(AuthGuard('api-key'))
  async create(
    @Body()
    body: {
      name: string;
      organizationId?: string | null;
      rolloutPercent?: number;
      minSampleSize?: number;
      controlStrategy: AuditStrategy;
      treatmentStrategies?: AuditStrategy[];
      metricsWeights?: MetricsWeights;
    },
  ) {
    return this.experimentsService.create(body);
  }

  @Patch(':id')
  @UseGuards(AuthGuard('api-key'))
  async updateStatus(
    @Param('id') id: string,
    @Body() body: { status: ExperimentStatus; rolloutPercent?: number },
  ) {
    return this.experimentsService.updateStatus(id, body.status, body.rolloutPercent);
  }

  @Post(':id/benchmark-runs')
  @UseGuards(AuthGuard('api-key'))
  async runBenchmark(
    @Param('id') id: string,
    @Body()
    body: {
      organizationId: string;
      repositoryFullName?: string | null;
      prNumber?: number | null;
      prTitle?: string;
      diffContent?: string;
      taskDescription?: string;
      createdBy?: string;
    },
  ) {
    return this.experimentsService.enqueueBenchmark(id, body);
  }

  @Post(':id/rankings')
  @UseGuards(AuthGuard('api-key'))
  async upsertRankings(
    @Param('id') id: string,
    @Body()
    body: {
      repositoryFullName: string;
      prNumber: number;
      rankedBy?: string;
      rankings: Array<{ variantId: string; rank: number }>;
    },
  ) {
    return this.experimentsService.upsertRankings(id, body);
  }

  @Post(':id/promote')
  @UseGuards(AuthGuard('api-key'))
  async promote(
    @Param('id') id: string,
    @Body()
    body: {
      variantId: string;
      scope: 'org' | 'repo';
      organizationId?: string;
      repositoryId?: string;
      promotedBy?: string;
    },
  ) {
    return this.promotionsService.promote(id, body);
  }

  @Post('active-flows/:id/revert')
  @UseGuards(AuthGuard('api-key'))
  async revertActiveFlow(@Param('id') id: string) {
    return this.promotionsService.revertActiveFlow(id);
  }

  @Post('benchmark-jobs/:id/cancel')
  @UseGuards(AuthGuard('api-key'))
  async cancelBenchmark(@Param('id') id: string) {
    return this.experimentsService.cancelBenchmark(id);
  }
}
