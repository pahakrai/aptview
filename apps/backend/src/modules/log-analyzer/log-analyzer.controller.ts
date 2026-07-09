import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
} from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { LogAnalyzerService, type LogAnalysisRequest } from './log-analyzer.service';

/**
 * LogAnalyzerController — REST + WebSocket gateway for log analysis.
 *
 * REST endpoints:
 *   POST /api/v1/log-analyzer/analyze   — Submit logs (text or file content)
 *   GET  /api/v1/log-analyzer/:id        — Get analysis result
 *
 * WebSocket:
 *   ws://localhost:3000/log-analyzer
 *   Events: log-analyzer:started, log-analyzer:complete
 */

@Controller('log-analyzer')
@WebSocketGateway({ namespace: '/log-analyzer', cors: true })
export class LogAnalyzerController implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  constructor(private readonly logAnalyzerService: LogAnalyzerService) {}

  handleConnection(client: Socket) {
    console.log(`[WS:LogAnalyzer] Client connected: ${client.id}`);
    this.logAnalyzerService.setServer(this.server);
  }

  /**
   * Submit logs for analysis.
   * Accepts raw log text or a filename+content pair from file upload.
   */
  @Post('analyze')
  async analyze(@Body() body: LogAnalysisRequest) {
    const { threadId } = await this.logAnalyzerService.startAnalysis(body);

    this.server.emit('log-analyzer:started', {
      threadId,
      fileName: body.fileName || 'pasted-logs.txt',
      logLength: body.logContent.length,
    });

    return {
      threadId,
      status: 'analyzing',
      message: `Analysis started. ${body.logContent.length} chars of logs queued.`,
    };
  }

  /**
   * Get analysis result by thread ID.
   */
  @Get(':id')
  async getResult(@Param('id') id: string) {
    const session = await this.logAnalyzerService.getSession(id);
    if (!session) {
      return { threadId: id, status: 'not_found' };
    }
    return session;
  }
}
