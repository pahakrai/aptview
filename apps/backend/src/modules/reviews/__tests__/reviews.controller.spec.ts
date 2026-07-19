/**
 * reviews.controller.spec.ts — Integration tests for the HITL action endpoint.
 *
 * Tests the full request/response contract of POST /reviews/:id/action
 * with all three actions (approve, revise, cancel) and edge cases.
 * ReviewsService is mocked — no BullMQ, no Redis, no LangGraph.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { ReviewsController } from '../reviews.controller';
import { ReviewsService } from '../reviews.service';

describe('ReviewsController — POST /reviews/:id/action', () => {
  let app: INestApplication;

  const mockService = {
    startReview: jest.fn().mockResolvedValue({ threadId: 'mock-thread-id' }),
    approveReview: jest.fn().mockResolvedValue(undefined),
    reviseReview: jest.fn().mockResolvedValue({ revisionCount: 1, remaining: 2 }),
    cancelReview: jest.fn().mockResolvedValue(undefined),
    getReview: jest.fn().mockResolvedValue(null),
    listPending: jest.fn().mockResolvedValue([]),
    savePendingReview: jest.fn().mockResolvedValue(undefined),
    updateReviewStatus: jest.fn().mockResolvedValue(undefined),
    setServer: jest.fn(),
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReviewsController],
      providers: [],
    })
      .overrideProvider(ReviewsService)
      .useValue(mockService)
      .compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // approve
  // =========================================================================

  describe('action: approve', () => {
    test('returns 200 with approved status when no notes provided', async () => {
      const res = await request(app.getHttpServer())
        .post('/reviews/test-123/action')
        .send({ action: 'approve' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('approved');
      expect(res.body.threadId).toBe('test-123');
      expect(mockService.approveReview).toHaveBeenCalledWith('test-123', undefined);
    });

    test('passes notes through to service', async () => {
      const res = await request(app.getHttpServer())
        .post('/reviews/test-123/action')
        .send({ action: 'approve', notes: 'LGTM — verify auth flow' });

      expect(res.status).toBe(201);
      expect(res.body.message).toContain('with your notes');
      expect(mockService.approveReview).toHaveBeenCalledWith(
        'test-123',
        'LGTM — verify auth flow',
      );
    });

    test('passes undefined notes when notes is empty string', async () => {
      const res = await request(app.getHttpServer())
        .post('/reviews/test-123/action')
        .send({ action: 'approve', notes: '' });

      expect(mockService.approveReview).toHaveBeenCalledWith('test-123', '');
    });
  });

  // =========================================================================
  // revise
  // =========================================================================

  describe('action: revise', () => {
    test('returns 200 with revision count and remaining', async () => {
      const res = await request(app.getHttpServer())
        .post('/reviews/test-123/action')
        .send({ action: 'revise', feedback: 'Check error handling in payment.ts' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('revising');
      expect(res.body.revisionCount).toBe(1);
      expect(res.body.remaining).toBe(2);
      expect(mockService.reviseReview).toHaveBeenCalledWith(
        'test-123',
        'Check error handling in payment.ts',
      );
    });

    test('returns error when feedback is empty string', async () => {
      const res = await request(app.getHttpServer())
        .post('/reviews/test-123/action')
        .send({ action: 'revise', feedback: '' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('error');
      expect(res.body.message).toContain('Feedback is required');
      expect(mockService.reviseReview).not.toHaveBeenCalled();
    });

    test('returns error when feedback is missing entirely', async () => {
      const res = await request(app.getHttpServer())
        .post('/reviews/test-123/action')
        .send({ action: 'revise' });

      expect(res.body.status).toBe('error');
      expect(res.body.message).toContain('Feedback is required');
      expect(mockService.reviseReview).not.toHaveBeenCalled();
    });

    test('returns error when feedback is whitespace only', async () => {
      const res = await request(app.getHttpServer())
        .post('/reviews/test-123/action')
        .send({ action: 'revise', feedback: '   ' });

      expect(res.body.status).toBe('error');
      expect(mockService.reviseReview).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // cancel
  // =========================================================================

  describe('action: cancel', () => {
    test('returns 200 with cancelled status', async () => {
      const res = await request(app.getHttpServer())
        .post('/reviews/test-123/action')
        .send({ action: 'cancel' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('cancelled');
      expect(res.body.message).toBe('Review discarded');
      expect(mockService.cancelReview).toHaveBeenCalledWith('test-123');
    });
  });

  // =========================================================================
  // unknown action
  // =========================================================================

  describe('unknown action', () => {
    test('returns error with helpful message', async () => {
      const res = await request(app.getHttpServer())
        .post('/reviews/test-123/action')
        .send({ action: 'delete' });

      expect(res.body.status).toBe('error');
      expect(res.body.message).toContain('Unknown action');
      expect(res.body.message).toContain("'delete'");
      expect(res.body.message).toContain("'approve'");
      expect(res.body.message).toContain("'revise'");
      expect(res.body.message).toContain("'cancel'");
    });
  });

  // =========================================================================
  // startReview (to ensure old endpoint still works)
  // =========================================================================

  describe('POST /reviews/start', () => {
    test('returns 200 with threadId', async () => {
      const res = await request(app.getHttpServer())
        .post('/reviews/start')
        .send({
          owner: 'acme',
          repo: 'api',
          prNumber: 42,
          prTitle: 'Test PR',
          commitSha: 'abc123',
          sourceBranch: 'feat',
          targetBranch: 'main',
          author: 'dev',
          diffContent: 'mock diff',
        });

      expect(res.status).toBe(201);
      expect(res.body.threadId).toBe('mock-thread-id');
      expect(res.body.status).toBe('queued');
    });
  });
});
