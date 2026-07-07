import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';

/**
 * ReviewCommenter — Posts AI-generated code reviews as GitHub PR reviews.
 *
 * Uses Octokit to create line-specific inline comments via the
 * GitHub Pull Request Review API.
 */

export interface ReviewComment {
  /** File path relative to repo root */
  path: string;
  /** Line number in the diff (position, not absolute line) */
  position: number;
  /** The AI review comment body (markdown) */
  body: string;
}

export interface PostReviewParams {
  owner: string;
  repo: string;
  prNumber: number;
  commitId: string;
  comments: ReviewComment[];
  /** GitHub review event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE' */
  event?: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';
  /** Optional summary body for the review */
  body?: string;
}

@Injectable()
export class ReviewCommenter {
  private readonly logger = new Logger(ReviewCommenter.name);
  private octokit: Octokit;

  constructor(private readonly configService: ConfigService) {
    const token = this.configService.get<string>('GITHUB_TOKEN');
    if (!token) {
      this.logger.warn('GITHUB_TOKEN not set — review posting will fail');
    }
    this.octokit = new Octokit({ auth: token });
  }

  /**
   * Post a review with line-specific comments to a GitHub PR.
   */
  async postReview(params: PostReviewParams): Promise<string> {
    const {
      owner, repo, prNumber, commitId, comments, body,
      event = 'COMMENT',
    } = params;

    this.logger.log(
      `Posting review to ${owner}/${repo}#${prNumber}: ${comments.length} comments, event=${event}`,
    );

    const response = await this.octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitId,
      event,
      body: body || undefined,
      comments: comments.map((c) => ({
        path: c.path,
        position: c.position,
        body: c.body,
      })),
    });

    this.logger.log(
      `Review posted: ${response.data.html_url}`,
    );

    return response.data.html_url;
  }

  /**
   * Post a simple summary comment on a PR (no line-specific annotations).
   */
  async postComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
  ): Promise<string> {
    const response = await this.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });

    return response.data.html_url;
  }

  /**
   * Fetch the diff for a PR.
   */
  async getDiff(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<string> {
    const response = await this.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: 'diff' },
    });

    // Octokit returns the diff as a string for this media type
    return response.data as unknown as string;
  }

  /**
   * Update a review comment.
   */
  async updateComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string,
  ): Promise<void> {
    await this.octokit.rest.pulls.updateReviewComment({
      owner,
      repo,
      comment_id: commentId,
      body,
    });
  }
}
