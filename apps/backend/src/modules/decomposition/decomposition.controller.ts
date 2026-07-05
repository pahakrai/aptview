import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { DecompositionService } from './decomposition.service';
import { DecompositionRequest, DeveloperRating } from '@aigov/shared-types';

@Controller('decomposition')
export class DecompositionController {
  constructor(private readonly decompService: DecompositionService) {}

  /**
   * Decompose a single task into sub-tasks.
   * Accepts parentTaskId for hierarchical decomposition.
   */
  @Post()
  async decompose(@Body() body: DecompositionRequest) {
    return this.decompService.enqueueDecomposition(body);
  }

  /**
   * Decompose a sprint into multiple top-level tasks.
   * Each can be further decomposed via POST /decomposition with parentTaskId.
   */
  @Post('sprint')
  async decomposeSprint(@Body() body: DecompositionRequest) {
    return this.decompService.decomposeSprint(body);
  }

  /**
   * List all decomposed tasks for an organization.
   */
  @Get('org/:orgId')
  async listByOrg(@Param('orgId') orgId: string) {
    return this.decompService.listByOrg(orgId);
  }

  /**
   * Get a single decomposed task by ID.
   */
  @Get(':id')
  async get(@Param('id') id: string) {
    return this.decompService.getById(id);
  }

  /**
   * Get all quantifiable sub-tasks for a decomposed task.
   * Returns acceptance criteria, complexity ratings, LOC estimates, and file boundaries.
   */
  @Get(':id/sub-tasks')
  async getSubTasks(@Param('id') id: string) {
    return this.decompService.getSubTasks(id);
  }

  /**
   * Submit developer feedback on decomposition quality.
   */
  @Post(':id/feedback')
  async submitFeedback(
    @Param('id') id: string,
    @Body()
    body: {
      developerRating: DeveloperRating;
      developerComment?: string;
      missedFiles?: string[];
      unnecessaryFiles?: string[];
    },
  ) {
    return this.decompService.submitFeedback(id, body);
  }
}
