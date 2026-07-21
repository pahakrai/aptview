import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { buildReviewGraph, setGraphDependencies, type ReviewStateType } from './review.graph';
import { ReviewCommenter } from './review-commenter';
import { ReviewsService } from './reviews.service';

/**
 * ReviewProcessor — BullMQ worker for the HITL review pipeline.
 *
 * Each review runs through up to four BullMQ job types:
 *   1. "review-analyze"  — runs fetchDiff → generateReview, pauses at humanGate
 *   2. "review-revise"    — human provides feedback, graph loops back to generateReview
 *   3. "review-post"      — human approves code review, posts to GitHub,
 *                           optionally starts Phase 2 (test generation)
 *   4. "test-post"        — human approves generated tests, posts to GitHub
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
  taskDescription?: string;
  guidelines?: string;
  repoContext?: string;
  changedFiles?: string;
}

export interface ReviseJobData {
  threadId: string;
  feedback: string;
}

export interface PostJobData {
  threadId: string;
  notes?: string;
  generateTests?: boolean;
  testTypes?: string[];
}

export interface TestPostJobData {
  threadId: string;
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

  async process(
    job: Job<ReviewJobData | ReviseJobData | PostJobData | TestPostJobData>,
  ): Promise<{ threadId: string; status: string }> {
    const jobType = job.name;

    if (jobType === 'review-analyze') return this.processAnalyzeJob(job as Job<ReviewJobData>);
    if (jobType === 'review-revise') return this.processReviseJob(job as Job<ReviseJobData>);
    if (jobType === 'review-post') return this.processPostJob(job as Job<PostJobData>);
    if (jobType === 'test-post') return this.processTestPostJob(job as Job<TestPostJobData>);

    throw new Error(`Unknown review job type: ${jobType}`);
  }

  /**
   * Job 1: Run fetchDiff → generateReview, pause at humanGate.
   */
  private async processAnalyzeJob(job: Job<ReviewJobData>): Promise<{ threadId: string; status: string }> {
    const data = job.data;
    console.log(`[ReviewProcessor] analyze: PR #${data.prNumber}, thread ${data.threadId}`);

    setGraphDependencies({
      deepseekApiKey: this.configService.get<string>('DEEPSEEK_API_KEY'),
      githubToken: this.configService.get<string>('GITHUB_TOKEN'),
    });

    const graph = buildReviewGraph();
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
      changedFiles: data.changedFiles || '',
      status: 'fetching',
    };

    const config = { configurable: { thread_id: data.threadId } };
    const result = await graph.invoke(initialState, config);

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
  private async processReviseJob(job: Job<ReviseJobData>): Promise<{ threadId: string; status: string }> {
    const { threadId, feedback } = job.data;
    console.log(`[ReviewProcessor] revise: thread ${threadId}`);

    setGraphDependencies({
      deepseekApiKey: this.configService.get<string>('DEEPSEEK_API_KEY'),
      githubToken: this.configService.get<string>('GITHUB_TOKEN'),
    });

    const graph = buildReviewGraph();
    const config = { configurable: { thread_id: threadId } };

    const state = await graph.getState(config);
    if (!state) throw new Error(`No checkpoint found for thread ${threadId}`);

    const currentState = state.values as ReviewStateType;
    const newRevisionCount = (currentState.revisionCount || 0) + 1;

    await graph.updateState(config, {
      humanFeedback: feedback,
      revisionCount: newRevisionCount,
      status: 'reviewing' as const,
    });

    const result = await graph.invoke(null, config);

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
   * Job 3 (post): Human approves code review.
   *
   * - Posts the code review to GitHub (with optional human notes).
   * - If generateTests is true: updates checkpoint with test flags, resumes
   *   the graph through Phase 2 (generateTests → reviewTests → testHumanGate ✋).
   * - Saves the test review as pending if Phase 2 runs.
   */
  private async processPostJob(job: Job<PostJobData>): Promise<{ threadId: string; status: string }> {
    const { threadId, notes, generateTests, testTypes } = job.data;
    const hasTests = generateTests && testTypes && testTypes.length > 0;
    console.log(`[ReviewProcessor] post: thread ${threadId}${notes ? ' (with notes)' : ''}${hasTests ? ' (tests requested)' : ''}`);

    setGraphDependencies({
      deepseekApiKey: this.configService.get<string>('DEEPSEEK_API_KEY'),
      githubToken: this.configService.get<string>('GITHUB_TOKEN'),
    });

    const graph = buildReviewGraph();
    const config = { configurable: { thread_id: threadId } };

    const state = await graph.getState(config);
    if (!state) throw new Error(`No checkpoint found for thread ${threadId}`);

    const reviewState = state.values as ReviewStateType;

    // Phase 1: Post code review to GitHub
    let finalBody = reviewState.reviewText || 'No review content';
    if (notes && notes.trim()) {
      finalBody = `${finalBody}\n\n---\n\n### Reviewer's Notes\n\n${notes.trim()}`;
    }

    if (notes) {
      await graph.updateState(config, {
        humanNotes: notes,
        status: 'awaiting_approval' as const,
      });
    }

    await this.reviewCommenter.postComment(
      reviewState.owner!,
      reviewState.repo!,
      reviewState.prNumber!,
      finalBody,
    );

    // Phase 2: If tests requested, update state and resume
    if (hasTests) {
      console.log(`[ReviewProcessor] Starting Phase 2: test generation for types=[${testTypes!.join(', ')}]`);

      await graph.updateState(config, {
        generateTests: true,
        testTypes: testTypes!,
      });

      // Resume: postToGitHub → afterPostToGitHub → generateTests → reviewTests → testHumanGate ✋
      const testResult = await graph.invoke(null, config);

      // Save pending test review for Phase 2 HITL
      await this.reviewsService.savePendingTestReview(threadId, {
        prNumber: reviewState.prNumber,
        prTitle: reviewState.prTitle,
        owner: reviewState.owner,
        repo: reviewState.repo,
        sourceBranch: reviewState.sourceBranch,
        targetBranch: reviewState.targetBranch,
        author: reviewState.author,
        generatedTestsContent: testResult.generatedTestsContent || '',
        testReviewText: testResult.testReviewText || '',
        testTypes: testTypes!,
        status: 'awaiting_approval',
      });

      console.log(`[ReviewProcessor] Phase 2 paused: test review ready for approval, thread ${threadId}`);

      return { threadId, status: 'awaiting_test_approval' };
    }

    // No tests requested — resume to completion
    const result = await graph.invoke(null, config);
    await this.reviewsService.updateReviewStatus(threadId, 'done');

    console.log(`[ReviewProcessor] post complete: thread ${threadId}`);
    return { threadId, status: 'done' };
  }

  /**
   * Job 4 (test-post): Human approves generated tests.
   *
   * Commits the test file to the PR branch so CI (test.yml) runs it.
   * The PR is blocked from merging until the generated tests pass.
   * Posts a summary comment with the test review text for human reference.
   */
  private async processTestPostJob(job: Job<TestPostJobData>): Promise<{ threadId: string; status: string }> {
    const { threadId } = job.data;
    console.log(`[ReviewProcessor] test-post: thread ${threadId}`);

    setGraphDependencies({
      deepseekApiKey: this.configService.get<string>('DEEPSEEK_API_KEY'),
      githubToken: this.configService.get<string>('GITHUB_TOKEN'),
    });

    const graph = buildReviewGraph();
    const config = { configurable: { thread_id: threadId } };

    const state = await graph.getState(config);
    if (!state) throw new Error(`No checkpoint found for thread ${threadId}`);

    const reviewState = state.values as ReviewStateType;

    const testContent = reviewState.generatedTestsContent || '';
    if (!testContent.trim()) {
      console.warn(`[ReviewProcessor] No test content to commit for thread ${threadId}`);
      const result = await graph.invoke(null, config);
      await this.reviewsService.updateReviewStatus(threadId, 'done');
      return { threadId, status: 'done' };
    }

    // Derive test file path from the PR's changed files.
    // Falls back to a pr-numbered path if no source files found.
    const testPath = this.deriveTestPath(
      reviewState.repoContext || '',
      reviewState.prNumber!,
    );

    // Commit the test file to the PR branch — this triggers CI
    await this.reviewCommenter.commitFileToBranch({
      owner: reviewState.owner!,
      repo: reviewState.repo!,
      path: testPath,
      content: testContent,
      branch: reviewState.sourceBranch!,
      message: `test: AI-generated ${(reviewState.testTypes || ['test']).join('/')} tests for PR #${reviewState.prNumber}`,
    });

    // Post a summary comment so the human sees the test review + CI link
    const summaryBody = [
      `## ✅ AI-Generated Tests Committed`,
      '',
      `**File:** \`${testPath}\``,
      `**Types:** ${(reviewState.testTypes || []).join(', ') || 'test'}`,
      '',
      `CI is running the generated tests. [View checks](https://github.com/${reviewState.owner}/${reviewState.repo}/pull/${reviewState.prNumber}/checks)`,
      '',
      '---',
      '',
      '### Test Review',
      '',
      reviewState.testReviewText || 'No test review generated.',
      '',
      '<details><summary>Generated test code</summary>',
      '',
      '```typescript',
      testContent.slice(0, 8000),
      testContent.length > 8000 ? '\n// ... (truncated, see committed file for full content)' : '',
      '```',
      '',
      '</details>',
    ].join('\n');

    await this.reviewCommenter.postComment(
      reviewState.owner!,
      reviewState.repo!,
      reviewState.prNumber!,
      summaryBody,
    );

    // Resume graph to completion
    const result = await graph.invoke(null, config);
    await this.reviewsService.updateReviewStatus(threadId, 'done');

    console.log(`[ReviewProcessor] test-post complete: ${testPath} committed to ${reviewState.sourceBranch}, thread ${threadId}`);
    return { threadId, status: 'done' };
  }

  /**
   * Derive a test file path from the PR's changed files.
   *
   * Parses the repoContext file listing (e.g. "  M  src/auth/login.ts")
   * and maps the first source file to a test path:
   *   src/auth/login.ts  →  src/auth/__tests__/login.test.ts
   *
   * Falls back to: src/__tests__/ai-generated-pr-{number}.test.ts
   */
  private deriveTestPath(repoContext: string, prNumber: number): string {
    // Extract changed file paths from repoContext listing
    // Format: "  M  src/auth/login.ts" or "  A  src/utils/new.ts"
    const filePattern = /^\s*[MAD]\s+(.+)$/gm;
    const matches = [...repoContext.matchAll(filePattern)];

    for (const match of matches) {
      const filePath = match[1].trim();
      // Skip files that are already tests
      if (filePath.match(/\.(test|spec)\.(ts|js|tsx|jsx)$/)) continue;
      if (filePath.includes('__tests__')) continue;
      if (filePath.match(/\.(test|spec)\./)) continue;

      // Map source file to test file path
      // src/auth/login.ts → src/auth/__tests__/login.test.ts
      const dir = filePath.substring(0, filePath.lastIndexOf('/'));
      const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
      const baseName = fileName.replace(/\.(ts|js|tsx|jsx)$/, '');
      const ext = fileName.endsWith('.tsx') ? '.tsx' : fileName.endsWith('.jsx') ? '.jsx' : '.ts';

      return `${dir}/__tests__/${baseName}.test${ext}`;
    }

    // Fallback: place in backend workspace (monorepo default)
    // test.yml watches apps/backend/** so the file must be under that tree
    return `apps/backend/src/__tests__/ai-generated-pr-${prNumber}.test.ts`;
  }
}
