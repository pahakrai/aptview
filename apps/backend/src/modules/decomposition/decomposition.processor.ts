import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { db } from '../../database/client';
import { decomposedTasks, subTasks } from '../../database/schema';
import { DecompositionRequest } from '@aigov/shared-types';
import { SandboxService } from '../audits/sandbox.service';

/**
 * DecompositionProcessor — BullMQ worker for task decomposition.
 *
 * Supports two modes:
 *   - INLINE (default): Returns placeholder defaults (dev-friendly, no K8s).
 *   - SANDBOX: Spawns an ephemeral K8s Job running CodeWhale to break a task
 *     into quantifiable sub-tasks with acceptance criteria, complexity ratings,
 *     LOC estimates, and file boundaries.
 *
 * Decomposition is hierarchical: a sprint decomposes into tasks, each of
 * which can decompose further into sub-tasks (via parentTaskId).
 */

interface SubTaskEntry {
  title: string;
  description: string;
  estimatedLoc: number;
  filesInScope: string[];
  acceptanceCriteria: string[];
  complexity: number;
  priority: number;
}

interface DecompositionOutput {
  estimatedLoc: number;
  filesInScope: string[];
  filesForbidden: string[];
  confidence: 'high' | 'medium' | 'low';
  needsClarification: boolean;
  subTasks: SubTaskEntry[];
}

@Processor('decomposition')
export class DecompositionProcessor extends WorkerHost {
  private readonly decompMode: 'inline' | 'sandbox';

  constructor(
    private readonly sandboxService: SandboxService,
    private readonly configService: ConfigService,
  ) {
    super();
    this.decompMode =
      this.configService.get<string>('DECOMP_MODE') === 'sandbox'
        ? 'sandbox'
        : 'inline';
  }

  async process(
    job: Job<DecompositionRequest>,
  ): Promise<{ taskId: string }> {
    if (this.decompMode === 'sandbox') {
      return this.processViaSandbox(job);
    }
    return this.processInline(job);
  }

  // =========================================================================
  // SANDBOX MODE — AI-powered decomposition
  // =========================================================================

  private async processViaSandbox(
    job: Job<DecompositionRequest>,
  ): Promise<{ taskId: string }> {
    const {
      organizationId,
      repositoryId,
      source,
      sourceTaskId,
      sourceTaskTitle,
      sourceTaskDescription,
      parentTaskId,
      sprintTitle,
      sprintGoal,
    } = job.data;

    const prompt = this.buildDecompositionPrompt({
      sourceTaskTitle,
      sourceTaskDescription,
      sprintTitle,
      sprintGoal,
    });

    const result = await this.sandboxService.runAudit({
      jobId: job.id || `decomp-${Date.now()}`,
      prompt,
      cpuLimit: '500m',
      memoryLimit: '256Mi',
    });

    const parsed = result.parsed as DecompositionOutput | null;

    const estimatedLoc = parsed?.estimatedLoc ??
      (parsed?.subTasks ?? []).reduce((sum, st) => sum + st.estimatedLoc, 0) ||
      120;

    const confidence =
      parsed?.confidence === 'high' || parsed?.confidence === 'low'
        ? parsed.confidence
        : 'medium';

    // Persist the parent decomposed task
    const [task] = await db
      .insert(decomposedTasks)
      .values({
        organizationId,
        repositoryId,
        source,
        sourceTaskId,
        sourceTaskTitle,
        parentTaskId: parentTaskId ?? null,
        confidence,
        needsClarification: parsed?.needsClarification ?? false,
        humanOverridesNeeded: 0,
        estimatedLoc,
        filesInScope: parsed?.filesInScope ?? [],
        filesForbidden: parsed?.filesForbidden ?? [],
      })
      .returning();

    // Persist sub-tasks
    const subtaskEntries = parsed?.subTasks ?? [];
    if (subtaskEntries.length > 0) {
      await db.insert(subTasks).values(
        subtaskEntries.map((st) => ({
          decomposedTaskId: task.id,
          title: st.title,
          description: st.description ?? null,
          estimatedLoc: st.estimatedLoc,
          filesInScope: st.filesInScope ?? [],
          acceptanceCriteria: st.acceptanceCriteria ?? [],
          complexity: Math.max(1, Math.min(5, st.complexity || 3)),
          priority: st.priority ?? 0,
          status: 'pending' as const,
        })),
      );
    }

    console.log(
      `Decomposition ${task.id}: "${sourceTaskTitle}" → ${subtaskEntries.length} sub-tasks, ${estimatedLoc} est LOC (mode: sandbox)`,
    );

    return { taskId: task.id };
  }

  // =========================================================================
  // INLINE MODE — Placeholder (existing behavior)
  // =========================================================================

  private async processInline(
    job: Job<DecompositionRequest>,
  ): Promise<{ taskId: string }> {
    const {
      organizationId,
      repositoryId,
      source,
      sourceTaskId,
      sourceTaskTitle,
      sourceTaskDescription,
      parentTaskId,
    } = job.data;

    const [task] = await db
      .insert(decomposedTasks)
      .values({
        organizationId,
        repositoryId,
        source,
        sourceTaskId,
        sourceTaskTitle,
        parentTaskId: parentTaskId ?? null,
        confidence: 'medium',
        needsClarification: false,
        humanOverridesNeeded: 0,
        estimatedLoc: 120,
        filesInScope: ['src/services/example.ts', 'src/types/example.ts'],
        filesForbidden: ['config/secrets.ts', 'migrations/', 'infra/'],
      })
      .returning();

    // Insert placeholder sub-tasks in inline mode
    await db.insert(subTasks).values([
      {
        decomposedTaskId: task.id,
        title: 'Implement core logic',
        description: sourceTaskDescription || 'Core implementation',
        estimatedLoc: 60,
        filesInScope: ['src/services/example.ts'],
        acceptanceCriteria: ['Feature works as described'],
        complexity: 3,
        priority: 0,
        status: 'pending' as const,
      },
      {
        decomposedTaskId: task.id,
        title: 'Add type definitions',
        description: 'TypeScript interfaces and types',
        estimatedLoc: 30,
        filesInScope: ['src/types/example.ts'],
        acceptanceCriteria: ['All types are exported', 'No `any` usage'],
        complexity: 2,
        priority: 1,
        status: 'pending' as const,
      },
      {
        decomposedTaskId: task.id,
        title: 'Write tests',
        description: 'Unit and integration tests',
        estimatedLoc: 30,
        filesInScope: ['src/services/example.test.ts'],
        acceptanceCriteria: [
          'Coverage above 80%',
          'Edge cases tested',
        ],
        complexity: 2,
        priority: 2,
        status: 'pending' as const,
      },
    ]);

    console.log(
      `Decomposition ${task.id} complete for task "${sourceTaskTitle}"`,
    );

    return { taskId: task.id };
  }

  // =========================================================================
  // Prompt builder
  // =========================================================================

  private buildDecompositionPrompt(params: {
    sourceTaskTitle: string;
    sourceTaskDescription: string;
    sprintTitle?: string;
    sprintGoal?: string;
  }): string {
    const { sourceTaskTitle, sourceTaskDescription, sprintTitle, sprintGoal } =
      params;

    const sprintContext =
      sprintTitle || sprintGoal
        ? [
            '## Sprint Context',
            sprintTitle ? `Sprint: ${sprintTitle}` : '',
            sprintGoal ? `Goal: ${sprintGoal}` : '',
            '',
          ]
            .filter(Boolean)
            .join('\n')
        : '';

    return [
      'You are a task decomposition engine for a code governance platform.',
      'Break the following task into quantifiable sub-tasks that can be individually estimated, assigned, and verified.',
      '',
      sprintContext,
      '## Task to Decompose',
      `Title: ${sourceTaskTitle}`,
      `Description: ${sourceTaskDescription}`,
      '',
      '## Instructions',
      'Analyze the task and produce a structured decomposition. Each sub-task must be quantifiable:',
      '- **acceptanceCriteria**: Concrete "done" conditions (list of strings). Each criterion should be testable.',
      '- **complexity**: 1–5 scale. 1 = trivial (single function), 3 = moderate (new file + tests), 5 = complex (new module, multiple files, architectural change).',
      '- **estimatedLoc**: Realistic LOC estimate for that sub-task.',
      '- **filesInScope**: Files that will be created or modified.',
      '- **priority**: 0 = highest, higher numbers = lower priority.',
      '',
      'Also provide:',
      '- **estimatedLoc**: Total LOC estimate for the entire task.',
      '- **filesInScope**: All files across all sub-tasks.',
      '- **filesForbidden**: Files that should NOT be touched.',
      '- **confidence**: high | medium | low — how confident are you in this decomposition?',
      '- **needsClarification**: true if the task description is too vague.',
      '',
      'Return valid JSON with exactly this shape:',
      '',
      '```json',
      '{',
      '  "estimatedLoc": <number>,',
      '  "filesInScope": ["<path>"],',
      '  "filesForbidden": ["<path>"],',
      '  "confidence": "high" | "medium" | "low",',
      '  "needsClarification": <boolean>,',
      '  "subTasks": [',
      '    {',
      '      "title": "<string>",',
      '      "description": "<string>",',
      '      "estimatedLoc": <number>,',
      '      "filesInScope": ["<path>"],',
      '      "acceptanceCriteria": ["<criterion>"],',
      '      "complexity": <1-5>,',
      '      "priority": <number>',
      '    }',
      '  ]',
      '}',
      '```',
      '',
      'Do not output anything except the JSON object. Do not wrap it in markdown fences.',
    ].join('\n');
  }
}
