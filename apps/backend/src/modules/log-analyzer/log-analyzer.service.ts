import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';

/**
 * LogAnalyzerService — Manages log analysis sessions.
 *
 * Simpler than ReviewsService: no HITL approval gate, no two-job split.
 * Just enqueue → analyze → return result.
 */

export interface LogAnalysisSession {
  threadId: string;
  fileName: string;
  logLength: number;
  analysisText: string;
  status: 'analyzing' | 'complete' | 'error';
  error: string;
  createdAt: string;
}

export interface LogAnalysisRequest {
  logContent: string;
  fileName?: string;
}

@Injectable()
export class LogAnalyzerService {
  private readonly sessions = new Map<string, LogAnalysisSession>();
  private webSocketServer: { emit: (event: string, data: unknown) => void } | null = null;

  constructor(@InjectQueue('log-analyzer') private readonly logQueue: Queue) {}

  setServer(server: { emit: (event: string, data: unknown) => void }) {
    this.webSocketServer = server;
  }

  /**
   * Enqueue a log analysis job. Returns immediately.
   */
  async startAnalysis(data: LogAnalysisRequest): Promise<{ threadId: string }> {
    const threadId = randomUUID();

    this.sessions.set(threadId, {
      threadId,
      fileName: data.fileName || 'pasted-logs.txt',
      logLength: data.logContent.length,
      analysisText: '',
      status: 'analyzing',
      error: '',
      createdAt: new Date().toISOString(),
    });

    await this.logQueue.add('log-analyze', { ...data, threadId });

    return { threadId };
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
   * Get a session by thread ID.
   */
  async getSession(threadId: string): Promise<LogAnalysisSession | null> {
    return this.sessions.get(threadId) || null;
  }
}
