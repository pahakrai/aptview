import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ExperimentsService } from './experiments.service';
import type {
  AuditStrategy,
  ExperimentStatus,
  MetricsWeights,
} from '@aigov/shared-types';

@Controller('experiments')
export class ExperimentsController {
  constructor(private readonly experimentsService: ExperimentsService) {}

  @Get()
  async list() {
    return this.experimentsService.list();
  }

  @Get(':id/report')
  async report(@Param('id') id: string) {
    return this.experimentsService.getReport(id);
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
}
