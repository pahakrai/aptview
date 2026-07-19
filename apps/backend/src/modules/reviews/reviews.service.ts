import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import type { ReviewJobData } from './review.processor';

/**
 * ReviewsService — Manages HITL review threads and state.
 *
 * Review state lifecycle:
 *   fetching → reviewing → awaiting_approval → posting → done
 *                                                  ↘ cancelled
 *
 * Revision loop:
 *   awaiting_approval → (revise) → reviewing → awaiting_approval (up to 3 rounds)
 *
 * Test generation (Phase 2):
 *   done (code review) → generating → reviewing_tests → awaiting_approval → posting → done
 */

export interface PendingReview {
  threadId: string;
  prNumber: number;
  prTitle: string;
  owner: string;
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  reviewText: string;
  status: 'awaiting_approval' | 'posting' | 'done' | 'cancelled';
  revisionCount: number;
  createdAt: string;
}

export interface PendingTestReview {
  threadId: string;
  prNumber: number;
  prTitle: string;
  owner: string;
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  generatedTestsContent: string;
  testReviewText: string;
  testTypes: string[];
  status: 'awaiting_approval' | 'posting' | 'done' | 'cancelled';
  createdAt: string;
}

const MAX_REVISIONS = 3;

@Injectable()
export class ReviewsService {
  private readonly reviews = new Map<string, PendingReview>();
  private readonly testReviews = new Map<string, PendingTestReview>();
  private webSocketServer: { emit: (event: string, data: unknown) => void } | null = null;

  constructor(
    @InjectQueue('reviews') private readonly reviewQueue: Queue,
  ) {}

  setServer(server: { emit: (event: string, data: unknown) => void }) {
    this.webSocketServer = server;
  }

  /**
   * Enqueue a review analysis job.
   */
  async startReview(data: Omit<ReviewJobData, 'threadId'>): Promise<{ threadId: string }> {
    const threadId = randomUUID();
    await this.reviewQueue.add('review-analyze', { ...data, threadId });
    return { threadId };
  }

  /**
   * Save a pending code review and notify WebSocket clients.
   */
  async savePendingReview(
    threadId: string,
    review: Omit<PendingReview, 'threadId' | 'createdAt' | 'revisionCount'> & { revisionCount?: number },
  ): Promise<void> {
    this.reviews.set(threadId, {
      ...review,
      revisionCount: review.revisionCount ?? 0,
      threadId,
      createdAt: new Date().toISOString(),
    });

    if (this.webSocketServer) {
      this.webSocketServer.emit('review:complete', {
        threadId,
        prNumber: review.prNumber,
        prTitle: review.prTitle,
        owner: review.owner,
        repo: review.repo,
        sourceBranch: review.sourceBranch,
        targetBranch: review.targetBranch,
        author: review.author,
        reviewText: review.reviewText,
        status: review.status,
        revisionCount: review.revisionCount ?? 0,
      });
    }
  }

  /**
   * Save a pending test review (Phase 2) and notify clients.
   */
  async savePendingTestReview(
    threadId: string,
    review: Omit<PendingTestReview, 'threadId' | 'createdAt'>,
  ): Promise<void> {
    this.testReviews.set(threadId, {
      ...review,
      threadId,
      createdAt: new Date().toISOString(),
    });

    if (this.webSocketServer) {
      this.webSocketServer.emit('review:complete', {
        threadId,
        prNumber: review.prNumber,
        prTitle: review.prTitle,
        owner: review.owner,
        repo: review.repo,
        phase: 'tests',
        generatedTestsContent: review.generatedTestsContent,
        testReviewText: review.testReviewText,
        testTypes: review.testTypes,
        status: review.status,
      });
    }
  }

  async getReview(threadId: string): Promise<PendingReview | null> {
    return this.reviews.get(threadId) || null;
  }

  async getTestReview(threadId: string): Promise<PendingTestReview | null> {
    return this.testReviews.get(threadId) || null;
  }

  async listPending(): Promise<PendingReview[]> {
    return Array.from(this.reviews.values())
      .filter((r) => r.status === 'awaiting_approval')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listPendingTestReviews(): Promise<PendingTestReview[]> {
    return Array.from(this.testReviews.values())
      .filter((r) => r.status === 'awaiting_approval')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Request a code review revision.
   */
  async reviseReview(threadId: string, feedback: string): Promise<{ revisionCount: number; remaining: number }> {
    const review = this.reviews.get(threadId);
    if (!review) throw new Error(`Review ${threadId} not found`);
    if (review.status !== 'awaiting_approval') {
      throw new Error(`Review ${threadId} is not awaiting approval (current: ${review.status})`);
    }

    const newCount = review.revisionCount + 1;
    if (newCount > MAX_REVISIONS) {
      throw new Error(`Maximum revision rounds (${MAX_REVISIONS}) reached. Please approve or cancel.`);
    }

    review.revisionCount = newCount;
    review.status = 'posting';
    this.reviews.set(threadId, review);

    await this.reviewQueue.add('review-revise', { threadId, feedback });

    if (this.webSocketServer) {
      this.webSocketServer.emit('review:status', {
        threadId, status: 'reviewing', revisionCount: newCount, remaining: MAX_REVISIONS - newCount,
      });
    }

    return { revisionCount: newCount, remaining: MAX_REVISIONS - newCount };
  }

  /**
   * Approve code review. Optionally triggers Phase 2 test generation.
   */
  async approveReview(
    threadId: string,
    notes?: string,
    generateTests?: boolean,
    testTypes?: string[],
  ): Promise<void> {
    const review = this.reviews.get(threadId);
    if (!review) throw new Error(`Review ${threadId} not found`);

    review.status = 'posting';
    this.reviews.set(threadId, review);

    await this.reviewQueue.add('review-post', { threadId, notes, generateTests, testTypes });
  }

  /**
   * Approve generated tests (Phase 2) — post to GitHub.
   */
  async approveTestsReview(threadId: string): Promise<void> {
    const review = this.testReviews.get(threadId);
    if (!review) throw new Error(`Test review ${threadId} not found`);

    review.status = 'posting';
    this.testReviews.set(threadId, review);

    await this.reviewQueue.add('test-post', { threadId });

    if (this.webSocketServer) {
      this.webSocketServer.emit('review:status', { threadId, status: 'posting', phase: 'tests' });
    }
  }

  async cancelReview(threadId: string): Promise<void> {
    const review = this.reviews.get(threadId);
    if (!review) throw new Error(`Review ${threadId} not found`);
    review.status = 'cancelled';
    this.reviews.set(threadId, review);
  }

  /**
   * Cancel a pending test review.
   */
  async cancelTestReview(threadId: string): Promise<void> {
    const review = this.testReviews.get(threadId);
    if (!review) throw new Error(`Test review ${threadId} not found`);
    review.status = 'cancelled';
    this.testReviews.set(threadId, review);
  }

  async updateReviewStatus(threadId: string, status: PendingReview['status']): Promise<void> {
    const review = this.reviews.get(threadId) || this.testReviews.get(threadId);
    if (review && 'status' in review) {
      (review as PendingReview).status = status as PendingReview['status'];
      if (this.reviews.has(threadId)) this.reviews.set(threadId, review as PendingReview);
    }
  }
}
