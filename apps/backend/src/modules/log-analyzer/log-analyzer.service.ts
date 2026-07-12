import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import { randomUUID } from 'crypto';

/**
 * LogAnalyzerService — Manages log analysis sessions.
 *
 * Lifecycle: enqueue → analyzing → (complete | error | cancelled).
 * Supports cancellation via AbortController — the running job checks
 * the signal between API calls and aborts gracefully.
 */

export interface LogAnalysisSession {
  threadId: string;
  fileName: string;
  logLength: number;
  analysisText: string;
  status: 'analyzing' | 'complete' | 'error' | 'cancelled';
  error: string;
  createdAt: string;
  /** BullMQ job ID for cancellation */
  jobId?: string;
}

export interface LogAnalysisRequest {
  logContent: string;
  fileName?: string;
}

@Injectable()
export class LogAnalyzerService {
  private readonly sessions = new Map<string, LogAnalysisSession>();
  /** Active AbortControllers keyed by threadId */
  private readonly abortControllers = new Map<string, AbortController>();
  private webSocketServer: { emit: (event: string, data: unknown) => void } | null = null;

  constructor(@InjectQueue('log-analyzer') private readonly logQueue: Queue) {}

  setServer(server: { emit: (event: string, data: unknown) => void }) {
    this.webSocketServer = server;
  }

  /**
   * Enqueue a log analysis job. Returns immediately.
   * Creates an AbortController so the job can be cancelled.
   */
  async startAnalysis(data: LogAnalysisRequest): Promise<{ threadId: string }> {
    const threadId = randomUUID();
    const abortController = new AbortController();

    this.abortControllers.set(threadId, abortController);

    const job = await this.logQueue.add('log-analyze', { ...data, threadId });

    this.sessions.set(threadId, {
      threadId,
      fileName: data.fileName || 'pasted-logs.txt',
      logLength: data.logContent.length,
      analysisText: '',
      status: 'analyzing',
      error: '',
      createdAt: new Date().toISOString(),
      jobId: job.id,
    });

    return { threadId };
  }

  /**
   * Get the AbortSignal for a running analysis.
   * Returns null if no analysis is running for this threadId.
   */
  getSignal(threadId: string): AbortSignal | null {
    return this.abortControllers.get(threadId)?.signal ?? null;
  }

  /**
   * Cancel a running analysis.
   * Aborts the AbortController (which stops the graph execution)
   * and removes the BullMQ job from the queue.
   */
  async cancelAnalysis(threadId: string): Promise<{ cancelled: boolean; message: string }> {
    const session = this.sessions.get(threadId);
    if (!session) {
      return { cancelled: false, message: 'Session not found' };
    }

    if (session.status !== 'analyzing') {
      return { cancelled: false, message: `Cannot cancel — status is "${session.status}"` };
    }

    // Abort the running graph execution
    const controller = this.abortControllers.get(threadId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(threadId);
    }

    // Remove the BullMQ job if still queued
    if (session.jobId) {
      try {
        const job = await Job.fromId(this.logQueue, session.jobId);
        if (job && (await job.getState()) !== 'completed') {
          await job.remove();
        }
      } catch {
        // Job may already be removed or completed
      }
    }

    session.status = 'cancelled';
    session.analysisText = 'Analysis cancelled by user.';
    this.sessions.set(threadId, session);

    if (this.webSocketServer) {
      this.webSocketServer.emit('log-analyzer:complete', {
        threadId,
        analysisText: session.analysisText,
        status: 'cancelled',
        fileName: session.fileName,
      });
    }

    console.log(`[LogAnalyzerService] Cancelled analysis: thread ${threadId}`);
    return { cancelled: true, message: 'Analysis cancelled' };
  }

  /**
   * Save analysis result and notify WebSocket clients.
   */
  async saveAnalysis(
    threadId: string,
    result: { analysisText: string; status: 'complete' | 'error'; error?: string },
  ): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;

    session.analysisText = result.analysisText;
    session.status = result.status;
    session.error = result.error || '';
    this.sessions.set(threadId, session);

    if (this.webSocketServer) {
      this.webSocketServer.emit('log-analyzer:complete', {
        threadId,
        analysisText: result.analysisText,
        status: result.status,
        fileName: session.fileName,
      });
    }
  }

  /**
   * Emit a streaming token to WebSocket clients.
   * Called by the processor during graph execution.
   */
  emitToken(threadId: string, token: string): void {
    if (this.webSocketServer) {
      this.webSocketServer.emit('log-analyzer:token', { threadId, token });
    }
  }

  /**
   * Get a session by thread ID.
   */
  async getSession(threadId: string): Promise<LogAnalysisSession | null> {
    return this.sessions.get(threadId) || null;
  }
}
