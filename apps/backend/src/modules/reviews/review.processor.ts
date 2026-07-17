import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { buildReviewGraph, setGraphDependencies, type ReviewStateType } from './review.graph';
import { ReviewCommenter } from './review-commenter';
import { ReviewsService } from './reviews.service';

/**
 * ReviewProcessor — BullMQ worker for the HITL review pipeline.
 *
 * Each review runs as up to three BullMQ job types:
 *   1. "review-analyze" — runs fetchDiff → generateReview, pauses at humanGate
 *   2. "review-revise"   — human provides feedback, graph loops back to generateReview
 *   3. "review-post"     — human approves (with optional notes), posts to GitHub
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

export interface ReviseJobData {
  threadId: string;
  feedback: string;
}

export interface PostJobData {
  threadId: string;
  notes?: string;
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

  async process(job: Job<ReviewJobData | ReviseJobData | PostJobData>): Promise<{ threadId: string; status: string }> {
    const jobType = job.name;

    if (jobType === 'review-analyze') {
      return this.processAnalyzeJob(job as Job<ReviewJobData>);
    }
    if (jobType === 'review-revise') {
      return this.processReviseJob(job as Job<ReviseJobData>);
    }
    if (jobType === 'review-post') {
      return this.processPostJob(job as Job<PostJobData>);
    }

    throw new Error(`Unknown review job type: ${jobType}`);
  }

  /**
   * Job 1: Run fetchDiff → generateReview, then pause at the humanGate interrupt.
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

    // Run the graph until it hits the interrupt before humanGate
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
   * Job 2 (revise): Human provides feedback — inject into state and loop back.
   */
  private async processReviseJob(
    job: Job<ReviseJobData>,
  ): Promise<{ threadId: string; status: string }> {
    const { threadId, feedback } = job.data;
    console.log(`[ReviewProcessor] revise: thread ${threadId}`);

    setGraphDependencies({
      deepseekApiKey: this.configService.get<string>('DEEPSEEK_API_KEY'),
      githubToken: this.configService.get<string>('GITHUB_TOKEN'),
    });

    const graph = buildReviewGraph();
    const config = { configurable: { thread_id: threadId } };

    // Load current checkpoint state
    const state = await graph.getState(config);
    if (!state) {
      throw new Error(`No checkpoint found for thread ${threadId}`);
    }

    const currentState = state.values as ReviewStateType;
    const newRevisionCount = (currentState.revisionCount || 0) + 1;

    // Update checkpoint: inject feedback, bump revision, switch status to reviewing
    // This tells the graph to loop back to generateReview after humanGate
    await graph.updateState(config, {
      humanFeedback: feedback,
      revisionCount: newRevisionCount,
      status: 'reviewing',
    });

    // Resume the graph — humanGate passes through, conditional routes to generateReview
    // generateReview picks up humanFeedback and re-generates
    const result = await graph.invoke(null, config);

    // Save the revised review
    await this.reviewsService.savePendingReview(threadId, {
      prNumber: currentState.prNumber,
      prTitle: currentState.prTitle,
      owner: currentState.owner,
      repo: currentState.repo,
      sourceBranch: currentState.sourceBranch,
      targetBranch: currentState.targetBranch,
      author: currentState.author,
      reviewText: result.reviewText || '',
      status: 'awaiting_approval',
    });

    console.log(`[ReviewProcessor] revise complete: thread ${threadId}, revision ${newRevisionCount}`);

    return { threadId, status: 'awaiting_approval' };
  }

  /**
   * Job 3 (post): Human approves — post to GitHub with optional notes, then resume to completion.
   */
  private async processPostJob(
    job: Job<PostJobData>,
  ): Promise<{ threadId: string; status: string }> {
    const { threadId, notes } = job.data;
    console.log(`[ReviewProcessor] post: thread ${threadId}${notes ? ' (with notes)' : ''}`);

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

    // Merge AI review text with human notes
    let finalBody = reviewState.reviewText || 'No review content';
    if (notes && notes.trim()) {
      finalBody = `${finalBody}\n\n---\n\n### Reviewer's Notes\n\n${notes.trim()}`;
    }

    // Store notes in checkpoint so the graph state is consistent
    if (notes) {
      await graph.updateState(config, {
        humanNotes: notes,
        status: 'awaiting_approval' as const,
      });
    }

    // Post to GitHub
    await this.reviewCommenter.postComment(
      reviewState.owner!,
      reviewState.repo!,
      reviewState.prNumber!,
      finalBody,
    );

    // Resume graph to completion (humanGate → postToGitHub → END)
    const result = await graph.invoke(null, config);

    // Update status
    await this.reviewsService.updateReviewStatus(threadId, 'done');

    console.log(`[ReviewProcessor] post complete: thread ${threadId}`);

    return { threadId, status: 'done' };
  }
}
