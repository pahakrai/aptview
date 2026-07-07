import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { buildReviewGraph, setGraphDependencies, type ReviewStateType } from './review.graph';
import { ReviewCommenter } from './review-commenter';
import { ReviewsService } from './reviews.service';

/**
 * ReviewProcessor — BullMQ worker for the HITL review pipeline.
 *
 * Each review runs as two BullMQ jobs:
 *   1. "review-analyze" — runs fetchDiff → generateReview, then interrupts
 *   2. "review-post"    — loaded from checkpoint, runs postToGitHub
 */

export interface ReviewJobData {
  threadId: string;
  prNumber: number;
  prTitle: string;
  commitSha: string;
  owner: string;
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  diffContent: string;
  /** PR body — used as task description for requirement coverage */
  taskDescription?: string;
  /** Active organization guidelines formatted for the LLM prompt */
  guidelines?: string;
  /** Full repo context — directory listing + key files (for cross-file analysis) */
  repoContext?: string;
}

@Processor('reviews')
export class ReviewProcessor extends WorkerHost {
  constructor(
    private readonly reviewsService: ReviewsService,
    private readonly reviewCommenter: ReviewCommenter,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async process(job: Job<ReviewJobData>): Promise<{ threadId: string; status: string }> {
    const jobType = job.name;

    if (jobType === 'review-analyze') {
      return this.processAnalyzeJob(job);
    }
    if (jobType === 'review-post') {
      return this.processPostJob(job);
    }

    throw new Error(`Unknown review job type: ${jobType}`);
  }

  /**
   * Job 1: Run fetchDiff → generateReview, then pause at the interrupt.
   */
  private async processAnalyzeJob(
    job: Job<ReviewJobData>,
  ): Promise<{ threadId: string; status: string }> {
    const data = job.data;
    console.log(`[ReviewProcessor] analyze: PR #${data.prNumber}, thread ${data.threadId}`);

    // Inject API keys for LLM calls
    setGraphDependencies({
      deepseekApiKey: this.configService.get<string>('DEEPSEEK_API_KEY'),
      githubToken: this.configService.get<string>('GITHUB_TOKEN'),
    });

    const graph = buildReviewGraph();

    // Initialise the graph with PR data
    const initialState: Partial<ReviewStateType> = {
      prNumber: data.prNumber,
      prTitle: data.prTitle,
      commitSha: data.commitSha,
      owner: data.owner,
      repo: data.repo,
      sourceBranch: data.sourceBranch,
      targetBranch: data.targetBranch,
      author: data.author,
      diffContent: data.diffContent,
      taskDescription: data.taskDescription || '',
      guidelines: data.guidelines || '',
      repoContext: data.repoContext || '',
      status: 'fetching',
    };

    const config = { configurable: { thread_id: data.threadId } };

    // Run the graph until it hits the interrupt before postToGitHub
    const result = await graph.invoke(initialState, config);

    // Store the review text for the HITL UI
    await this.reviewsService.savePendingReview(data.threadId, {
      prNumber: data.prNumber,
      prTitle: data.prTitle,
      owner: data.owner,
      repo: data.repo,
      sourceBranch: data.sourceBranch,
      targetBranch: data.targetBranch,
      author: data.author,
      reviewText: result.reviewText || '',
      status: 'awaiting_approval',
    });

    console.log(`[ReviewProcessor] analyze complete: thread ${data.threadId}, status: awaiting_approval`);

    return { threadId: data.threadId, status: 'awaiting_approval' };
  }

  /**
   * Job 2: Resume from checkpoint and run postToGitHub.
   */
  private async processPostJob(
    job: Job<{ threadId: string }>,
  ): Promise<{ threadId: string; status: string }> {
    const { threadId } = job.data;
    console.log(`[ReviewProcessor] post: resuming thread ${threadId}`);

    setGraphDependencies({
      deepseekApiKey: this.configService.get<string>('DEEPSEEK_API_KEY'),
      githubToken: this.configService.get<string>('GITHUB_TOKEN'),
    });

    const graph = buildReviewGraph();
    const config = { configurable: { thread_id: threadId } };

    // Load checkpoint state
    const state = await graph.getState(config);
    if (!state) {
      throw new Error(`No checkpoint found for thread ${threadId}`);
    }

    const reviewState = state.values as ReviewStateType;

    // Post to GitHub
    await this.reviewCommenter.postComment(
      reviewState.owner!,
      reviewState.repo!,
      reviewState.prNumber!,
      reviewState.reviewText || 'No review content',
    );

    // Resume to completion
    const result = await graph.invoke(null, config);

    // Update status
    await this.reviewsService.updateReviewStatus(threadId, 'done');

    console.log(`[ReviewProcessor] post complete: thread ${threadId}`);

    return { threadId, status: 'done' };
  }
}
