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
 *   POST /api/v1/reviews/:id/approve — Approve and post to GitHub
 *   POST /api/v1/reviews/:id/cancel  — Cancel the review
 *   GET  /api/v1/reviews/pending     — List pending reviews
 *   GET  /api/v1/reviews/:id         — Get review status + text
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
   * Approve a pending review — resumes the LangGraph to postToGitHub.
   */
  @Post(':id/approve')
  async approve(@Param('id') id: string) {
    await this.reviewsService.approveReview(id);

    this.server.emit('review:status', { threadId: id, status: 'posting' });

    return { threadId: id, status: 'approved', message: 'Review posting to GitHub' };
  }

  /**
   * Cancel a pending review — never posts to GitHub.
   */
  @Post(':id/cancel')
  async cancel(@Param('id') id: string) {
    await this.reviewsService.cancelReview(id);

    this.server.emit('review:status', { threadId: id, status: 'cancelled' });

    return { threadId: id, status: 'cancelled', message: 'Review discarded' };
  }

  /**
   * Get a specific review by thread ID.
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
