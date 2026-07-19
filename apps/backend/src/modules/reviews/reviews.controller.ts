import {
  Controller, Get, Post, Param, Body,
  WebSocketGateway, WebSocketServer,
  SubscribeMessage, OnGatewayConnection,
} from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { ReviewsService } from './reviews.service';
import type { ReviewJobData } from './review.processor';

/**
 * ReviewsController — REST + WebSocket gateway for HITL reviews.
 *
 * REST endpoints:
 *   POST /api/v1/reviews/start           — Start a review (called by webhook)
 *   POST /api/v1/reviews/:id/action      — Approve, cancel, revise, or test actions
 *   GET  /api/v1/reviews/pending         — List pending code reviews
 *   GET  /api/v1/reviews/tests/pending   — List pending test reviews
 *   GET  /api/v1/reviews/:id             — Get review status + text
 *
 * Action payload:
 *   { action: 'approve', notes?, generateTests?, testTypes? }
 *   { action: 'revise', feedback: string }
 *   { action: 'cancel' }
 *   { action: 'approve-tests' }           — Approve generated tests (Phase 2)
 *   { action: 'cancel-tests' }            — Discard generated tests
 *
 * WebSocket:
 *   ws://localhost:3000/reviews
 *   Events: review:started, review:token, review:complete, review:status
 */

@Controller('reviews')
@WebSocketGateway({ namespace: '/reviews', cors: true })
export class ReviewsController implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  constructor(private readonly reviewsService: ReviewsService) {}

  handleConnection(client: Socket) {
    console.log(`[WS] Client connected: ${client.id}`);
    this.reviewsService.setServer(this.server);
  }

  // ===========================================================================
  // REST endpoints
  // ===========================================================================

  /**
   * Start a new review.
   */
  @Post('start')
  async startReview(@Body() body: Omit<ReviewJobData, 'threadId'>) {
    const { threadId } = await this.reviewsService.startReview(body);

    this.server.emit('review:started', {
      threadId,
      prNumber: body.prNumber,
      prTitle: body.prTitle,
      owner: body.owner,
      repo: body.repo,
      sourceBranch: body.sourceBranch,
      targetBranch: body.targetBranch,
      author: body.author,
    });

    return { threadId, status: 'queued' };
  }

  /**
   * Unified HITL action endpoint — Phase 1 and Phase 2.
   *
   * Body:
   *   Phase 1: { action: 'approve', notes?, generateTests?, testTypes? }
   *            { action: 'revise', feedback }
   *            { action: 'cancel' }
   *   Phase 2: { action: 'approve-tests' }
   *            { action: 'cancel-tests' }
   */
  @Post(':id/action')
  async handleAction(
    @Param('id') id: string,
    @Body() body: {
      action: string;
      notes?: string;
      feedback?: string;
      generateTests?: boolean;
      testTypes?: string[];
    },
  ) {
    switch (body.action) {
      // ---- Phase 1: Code Review ----

      case 'approve': {
        await this.reviewsService.approveReview(
          id,
          body.notes,
          body.generateTests,
          body.testTypes,
        );
        this.server.emit('review:status', { threadId: id, status: 'posting' });

        const hasTests = body.generateTests && body.testTypes && body.testTypes.length > 0;
        return {
          threadId: id,
          status: 'approved',
          message: hasTests
            ? `Code review posted. Generating ${body.testTypes!.join(' and ')} tests...`
            : body.notes
              ? 'Review posting to GitHub with your notes'
              : 'Review posting to GitHub',
          phase: hasTests ? 'tests_pending' : undefined,
        };
      }

      case 'revise': {
        if (!body.feedback || !body.feedback.trim()) {
          return { threadId: id, status: 'error', message: 'Feedback is required when requesting a revision' };
        }
        const { revisionCount, remaining } = await this.reviewsService.reviseReview(id, body.feedback);
        return {
          threadId: id, status: 'revising', revisionCount, remaining,
          message: `Revision ${revisionCount} requested. ${remaining} round(s) remaining.`,
        };
      }

      case 'cancel': {
        await this.reviewsService.cancelReview(id);
        this.server.emit('review:status', { threadId: id, status: 'cancelled' });
        return { threadId: id, status: 'cancelled', message: 'Review discarded' };
      }

      // ---- Phase 2: Test Generation ----

      case 'approve-tests': {
        await this.reviewsService.approveTestsReview(id);
        this.server.emit('review:status', { threadId: id, status: 'posting', phase: 'tests' });
        return { threadId: id, status: 'approved', phase: 'tests', message: 'Tests posting to GitHub' };
      }

      case 'cancel-tests': {
        await this.reviewsService.cancelTestReview(id);
        this.server.emit('review:status', { threadId: id, status: 'cancelled', phase: 'tests' });
        return { threadId: id, status: 'cancelled', phase: 'tests', message: 'Tests discarded' };
      }

      default:
        return {
          threadId: id, status: 'error',
          message: `Unknown action: "${body.action}". Use 'approve', 'revise', 'cancel', 'approve-tests', or 'cancel-tests'.`,
        };
    }
  }

  /**
   * List pending code reviews.
   */
  @Get('pending')
  async listPending() {
    return this.reviewsService.listPending();
  }

  /**
   * List pending test reviews (Phase 2).
   */
  @Get('tests/pending')
  async listPendingTestReviews() {
    return this.reviewsService.listPendingTestReviews();
  }

  /**
   * Get a specific review by thread ID.
   */
  @Get(':id')
  async getReview(@Param('id') id: string) {
    const review = await this.reviewsService.getReview(id);
    const testReview = await this.reviewsService.getTestReview(id);
    if (!review && !testReview) {
      return { threadId: id, status: 'not_found' };
    }
    return {
      review: review || null,
      testReview: testReview || null,
    };
  }
}
