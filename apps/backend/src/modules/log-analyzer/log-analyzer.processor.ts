import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import {
  buildLogAnalyzerGraph,
  setLogAnalyzerDependencies,
  type LogAnalysisStateType,
} from './log-analyzer.graph';
import { LogAnalyzerService } from './log-analyzer.service';
import { McpBridge, type McpServerConfig } from './mcp-bridge';
import { buildUnifiedToolbox, setMcpBridge } from './toolbox';

export interface LogAnalyzerJobData {
  threadId: string;
  logContent: string;
  fileName?: string;
}

/**
 * LogAnalyzerProcessor — BullMQ worker for log analysis jobs.
 *
 * On module init, it reads feature flags from the ConfigMap (mounted as env vars)
 * and auto-generates the LOG_ANALYZER_MCP_CONFIG JSON — no manual secret needed.
 *
 * Feature flags (set in k8s/mcp-config.yaml):
 *   LOG_ANALYZER_MCP_ENABLED  — master switch ("true" to enable MCP)
 *   LOG_ANALYZER_MCP_K8S      — enable Kubernetes MCP server
 *   LOG_ANALYZER_MCP_AWS      — enable AWS CloudWatch MCP server
 *   LOG_ANALYZER_MCP_GCP      — enable GCP Cloud Logging MCP server
 *
 * Then for each job:
 *   1. Builds the unified toolbox (core tools + local skills + MCP tools)
 *   2. Calls graph.invoke() — DeepSeek drives the tool loop
 *   3. Saves the result and notifies WebSocket clients
 */
@Processor('log-analyzer')
export class LogAnalyzerProcessor extends WorkerHost {
  private mcpBridge: McpBridge | null = null;

  constructor(
    private readonly logAnalyzerService: LogAnalyzerService,
    private readonly configService: ConfigService,
  ) {
    super();
    this.initializeMcpBridge();
  }

  /**
   * Auto-generate MCP config from feature flags and connect.
   * This runs in the constructor — the bridge is ready before the first job.
   */
  private async initializeMcpBridge(): Promise<void> {
    const enabled = this.configService.get<string>('LOG_ANALYZER_MCP_ENABLED');
    if (enabled !== 'true') {
      console.log(
        '[LogAnalyzerProcessor] MCP disabled — set LOG_ANALYZER_MCP_ENABLED=true in k8s/mcp-config.yaml to enable',
      );
      return;
    }

    const configs = this.buildMcpConfigFromFlags();
    if (Object.keys(configs).length === 0) {
      console.log('[LogAnalyzerProcessor] No MCP servers enabled — all feature flags are false');
      return;
    }

    this.mcpBridge = new McpBridge();
    const mcpTools = await this.mcpBridge.connect(configs);
    setMcpBridge(this.mcpBridge);

    const sources = Object.keys(configs).join(', ');
    console.log(
      `[LogAnalyzerProcessor] MCP bridge online: ${mcpTools.length} tools from ${sources}`,
    );
  }

  /**
   * Build the MCP server config JSON from individual feature flags.
   *
   * Each MCP server gets its config from these env vars (all from ConfigMap):
   *   MCP_{SOURCE}_COMMAND  — binary to spawn (default: "npx")
   *   MCP_{SOURCE}_ARGS     — arguments (default: the MCP package name)
   *
   * Cloud-specific env vars:
   *   AWS_REGION            — for CloudWatch MCP
   *   GCP_PROJECT_ID        — for GCP Cloud Logging MCP
   *   GOOGLE_APPLICATION_CREDENTIALS — path to GCP key (mounted via volume)
   */
  /**
   * Build MCP server config from feature flags.
   *
   * In K8s (default): uses SSE transport with localhost URLs.
   *   MCP servers run as sidecar containers in the same pod.
   *   No child processes — the McpBridge connects via HTTP.
   *
   * In local dev (MCP_TRANSPORT_MODE=stdio): uses stdio transport.
   */
  private buildMcpConfigFromFlags(): Record<string, McpServerConfig> {
    const configs: Record<string, McpServerConfig> = {};
    const mode = this.configService.get<string>('MCP_TRANSPORT_MODE') || 'sse';

    // --- Kubernetes MCP ---
    if (this.configService.get<string>('LOG_ANALYZER_MCP_K8S') === 'true') {
      if (mode === 'sse') {
        configs.k8s = {
          transport: 'sse',
          url: this.configService.get<string>('MCP_K8S_URL') || 'http://localhost:8081/sse',
        };
      } else {
        configs.k8s = {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@flux159/mcp-server-kubernetes'],
        };
      }
      console.log(`[LogAnalyzerProcessor] MCP K8s enabled (${mode})`);
    }

    // --- AWS CloudWatch MCP ---
    if (this.configService.get<string>('LOG_ANALYZER_MCP_AWS') === 'true') {
      if (mode === 'sse') {
        configs.aws = {
          transport: 'sse',
          url: this.configService.get<string>('MCP_AWS_URL') || 'http://localhost:8082/sse',
        };
      } else {
        configs.aws = {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@awslabs/amazon-cloudwatch-logs-mcp'],
          env: { AWS_REGION: this.configService.get<string>('AWS_REGION') || 'us-east-1' },
        };
      }
      console.log(`[LogAnalyzerProcessor] MCP AWS enabled (${mode})`);
    }

    // --- Kubetail MCP (log aggregation across replicas) ---
    if (this.configService.get<string>('LOG_ANALYZER_MCP_KUBETAIL') === 'true') {
      if (mode === 'sse') {
        configs.kubetail = {
          transport: 'sse',
          url: this.configService.get<string>('MCP_KUBETAIL_URL') || 'http://localhost:8084/sse',
        };
      } else {
        configs.kubetail = {
          transport: 'stdio',
          command: 'uvx',
          args: ['kubetail-mcp'],
        };
      }
      console.log(`[LogAnalyzerProcessor] MCP Kubetail enabled (${mode})`);
    }

    // --- GCP Cloud Logging MCP ---
    if (this.configService.get<string>('LOG_ANALYZER_MCP_GCP') === 'true') {
      if (mode === 'sse') {
        configs.gcp = {
          transport: 'sse',
          url: this.configService.get<string>('MCP_GCP_URL') || 'http://localhost:8083/sse',
        };
      } else {
        const credsPath = this.configService.get<string>('GCP_CREDENTIALS_PATH') || '/secrets/gcp/gcp-key.json';
        configs.gcp = {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@swen128/cloud-logging-mcp'],
          env: { GOOGLE_APPLICATION_CREDENTIALS: credsPath },
        };
      }
      console.log(`[LogAnalyzerProcessor] MCP GCP enabled (${mode})`);
    }

    return configs;
  }

  async process(
    job: Job<LogAnalyzerJobData>,
  ): Promise<{ threadId: string; status: string }> {
    const { threadId, logContent, fileName } = job.data;
    console.log(
      `[LogAnalyzerProcessor] analyzing: thread ${threadId}, ${logContent.length} chars`,
    );

    // Build the unified toolbox (core + local skills + MCP if connected)
    const toolbox = await buildUnifiedToolbox();
    console.log(
      `[LogAnalyzerProcessor] Toolbox: ${toolbox.toolDefinitions.length} tools ` +
      `(core=${[...toolbox.toolLayers.values()].filter((v) => v === 'core').length}, ` +
      `skills=${[...toolbox.toolLayers.values()].filter((v) => v === 'local-skill').length}, ` +
      `mcp=${[...toolbox.toolLayers.values()].filter((v) => v === 'mcp').length})`,
    );

    setLogAnalyzerDependencies({
      deepseekApiKey: this.configService.get<string>('DEEPSEEK_API_KEY'),
      toolbox,
      onToken: (token: string) => {
        this.logAnalyzerService.emitToken(threadId, token);
      },
      abortSignal: this.logAnalyzerService.getSignal(threadId),
    });

    const graph = buildLogAnalyzerGraph();

    const initialState: Partial<LogAnalysisStateType> = {
      logContent,
      fileName: fileName || 'pasted-logs.txt',
      status: 'analyzing',
    };

    const config = { configurable: { thread_id: threadId } };

    try {
      const result = await graph.invoke(initialState, config);

      await this.logAnalyzerService.saveAnalysis(threadId, {
        analysisText: result.analysisText || '',
        status: result.status === 'error' ? 'error' : 'complete',
        error: result.error,
      });

      console.log(
        `[LogAnalyzerProcessor] complete: thread ${threadId}, status: ${result.status}`,
      );

      return { threadId, status: result.status };
    } catch (err) {
      console.error('[LogAnalyzerProcessor] error:', err);
      await this.logAnalyzerService.saveAnalysis(threadId, {
        analysisText: `## Analysis Failed\n\n${(err as Error).message}`,
        status: 'error',
        error: (err as Error).message,
      });
      return { threadId, status: 'error' };
    }
  }
}
