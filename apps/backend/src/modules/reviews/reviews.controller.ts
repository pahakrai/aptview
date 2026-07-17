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
 *   POST /api/v1/reviews/start    — Start a review (called by webhook)
 *   POST /api/v1/reviews/:id/action — Approve, cancel, or request revision
 *   GET  /api/v1/reviews/pending     — List pending reviews
 *   GET  /api/v1/reviews/:id         — Get review status + text
 *
 * Action payload:
 *   { action: 'approve', notes?: string }    — Post to GitHub (with optional notes)
 *   { action: 'revise', feedback: string }   — Re-generate with feedback (max 3 rounds)
 *   { action: 'cancel' }                     — Discard review
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
    // Share the WebSocket server with ReviewsService so the processor can emit events
    this.reviewsService.setServer(this.server);
  }

  // ===========================================================================
  // REST endpoints
  // ===========================================================================

  /**
   * Start a new review. Called by the webhook handler after HMAC validation.
   */
  @Post('start')
  async startReview(@Body() body: Omit<ReviewJobData, 'threadId'>) {
    const { threadId } = await this.reviewsService.startReview(body);

    // Notify WebSocket clients
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
   * Unified HITL action endpoint.
   *
   * Body: { action: 'approve' | 'revise' | 'cancel', [notes?: string], [feedback?: string] }
   */
  @Post(':id/action')
  async handleAction(
    @Param('id') id: string,
    @Body() body: { action: string; notes?: string; feedback?: string },
  ) {
    switch (body.action) {
      case 'approve': {
        await this.reviewsService.approveReview(id, body.notes);
        this.server.emit('review:status', { threadId: id, status: 'posting' });
        return {
          threadId: id,
          status: 'approved',
          message: body.notes
            ? 'Review posting to GitHub with your notes'
            : 'Review posting to GitHub',
        };
      }

      case 'revise': {
        if (!body.feedback || !body.feedback.trim()) {
          return {
            threadId: id,
            status: 'error',
            message: 'Feedback is required when requesting a revision',
          };
        }
        const { revisionCount, remaining } = await this.reviewsService.reviseReview(id, body.feedback);
        return {
          threadId: id,
          status: 'revising',
          revisionCount,
          remaining,
          message: `Revision ${revisionCount} requested. ${remaining} round(s) remaining.`,
        };
      }

      case 'cancel': {
        await this.reviewsService.cancelReview(id);
        this.server.emit('review:status', { threadId: id, status: 'cancelled' });
        return { threadId: id, status: 'cancelled', message: 'Review discarded' };
      }

      default:
        return {
          threadId: id,
          status: 'error',
          message: `Unknown action: "${body.action}". Use 'approve', 'revise', or 'cancel'.`,
        };
    }
  }

  /**
   * List all pending reviews (awaiting human approval).
   */
  @Get('pending')
  async listPending() {
    return this.reviewsService.listPending();
  }

  /**
   * Get a specific review by thread ID.
   */
  @Get(':id')
  async getReview(@Param('id') id: string) {
    const review = await this.reviewsService.getReview(id);
    if (!review) {
      return { threadId: id, status: 'not_found' };
    }
    return review;
  }
}
