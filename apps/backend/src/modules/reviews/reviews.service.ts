import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { randomUUID } from 'crypto';
import type { ReviewJobData } from './review.processor';

/**
 * ReviewsService — Manages HITL review threads and state.
 *
 * Review state lifecycle:
 *   fetching → reviewing → awaiting_approval → posting → done
 *                                                  ↘ cancelled
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
  createdAt: string;
}

@Injectable()
export class ReviewsService {
  private readonly reviews = new Map<string, PendingReview>();

  constructor(
    @InjectQueue('reviews') private readonly reviewQueue: Queue,
  ) {}

  /**
   * Enqueue a review analysis job. Returns immediately — the review runs async.
   */
  async startReview(data: Omit<ReviewJobData, 'threadId'>): Promise<{ threadId: string }> {
    const threadId = randomUUID();

    await this.reviewQueue.add('review-analyze', {
      ...data,
      threadId,
    });

    return { threadId };
  }

  /**
   * Save a pending review in memory (for demo/desktop use).
   * In production, persist to PostgreSQL or Redis.
   */
  async savePendingReview(threadId: string, review: Omit<PendingReview, 'threadId' | 'createdAt'>): Promise<void> {
    this.reviews.set(threadId, {
      ...review,
      threadId,
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Get a pending review by thread ID.
   */
  async getReview(threadId: string): Promise<PendingReview | null> {
    return this.reviews.get(threadId) || null;
  }

  /**
   * List all pending reviews (awaiting human approval).
   */
  async listPending(): Promise<PendingReview[]> {
    return Array.from(this.reviews.values())
      .filter((r) => r.status === 'awaiting_approval')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Approve a pending review — enqueues the post job.
   */
  async approveReview(threadId: string): Promise<void> {
    const review = this.reviews.get(threadId);
    if (!review) throw new Error(`Review ${threadId} not found`);

    review.status = 'posting';
    this.reviews.set(threadId, review);

    await this.reviewQueue.add('review-post', { threadId });
  }

  /**
   * Cancel a pending review — marks as cancelled, never posts to GitHub.
   */
  async cancelReview(threadId: string): Promise<void> {
    const review = this.reviews.get(threadId);
    if (!review) throw new Error(`Review ${threadId} not found`);

    review.status = 'cancelled';
    this.reviews.set(threadId, review);
  }

  /**
   * Update the status of a review.
   */
  async updateReviewStatus(threadId: string, status: PendingReview['status']): Promise<void> {
    const review = this.reviews.get(threadId);
    if (review) {
      review.status = status;
      this.reviews.set(threadId, review);
    }
  }
}
