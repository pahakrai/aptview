import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { db } from '../../database/client';
import { decomposedTasks, decompositionFeedback, subTasks } from '../../database/schema';
import { eq, desc } from 'drizzle-orm';
import { DecompositionRequest, DeveloperRating, SubTask } from '@aigov/shared-types';

@Injectable()
export class DecompositionService {
  constructor(
    @InjectQueue('decomposition') private readonly decompQueue: Queue,
  ) {}

  async enqueueDecomposition(request: DecompositionRequest) {
    const job = await this.decompQueue.add('decompose-task', request, {
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
    });

    return {
      jobId: job.id,
      status: 'queued',
      message: 'Task decomposition in progress.',
    };
  }

  /**
   * Decompose a sprint into multiple top-level tasks.
   * Each task can then be decomposed further into sub-tasks via the standard
   * decomposition endpoint with parentTaskId.
   */
  async decomposeSprint(request: DecompositionRequest) {
    return this.enqueueDecomposition({
      ...request,
      sourceTaskTitle: request.sprintTitle || request.sourceTaskTitle,
      sourceTaskDescription: request.sprintGoal || request.sourceTaskDescription,
    });
  }

  async getById(id: string) {
    const [task] = await db
      .select()
      .from(decomposedTasks)
      .where(eq(decomposedTasks.id, id))
      .limit(1);

    if (!task) throw new NotFoundException(`Decomposed task ${id} not found`);
    return task;
  }

  /**
   * Get all sub-tasks for a decomposed task, ordered by priority.
   */
  async getSubTasks(decomposedTaskId: string): Promise<SubTask[]> {
    // Verify parent exists
    await this.getById(decomposedTaskId);

    const rows = await db
      .select()
      .from(subTasks)
      .where(eq(subTasks.decomposedTaskId, decomposedTaskId))
      .orderBy(subTasks.priority);

    return rows.map((r) => ({
      id: r.id,
      decomposedTaskId: r.decomposedTaskId,
      title: r.title,
      description: r.description ?? '',
      estimatedLoc: r.estimatedLoc,
      filesInScope: r.filesInScope,
      acceptanceCriteria: r.acceptanceCriteria,
      complexity: r.complexity,
      priority: r.priority,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async listByOrg(organizationId: string) {
    return db
      .select()
      .from(decomposedTasks)
      .where(eq(decomposedTasks.organizationId, organizationId))
      .orderBy(desc(decomposedTasks.createdAt));
  }

  async submitFeedback(
    taskId: string,
    input: {
      developerRating: DeveloperRating;
      developerComment?: string;
      missedFiles?: string[];
      unnecessaryFiles?: string[];
    },
  ) {
    const [feedback] = await db
      .insert(decompositionFeedback)
      .values({
        decomposedTaskId: taskId,
        developerRating: input.developerRating,
        developerComment: input.developerComment ?? null,
        missedFiles: input.missedFiles ?? [],
        unnecessaryFiles: input.unnecessaryFiles ?? [],
      })
      .returning();

    return feedback;
  }
}
