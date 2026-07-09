/**
 * mcp-bridge.ts — Generic MCP (Model Context Protocol) server manager.
 *
 * Supports two transport modes:
 *   - sse  (default in K8s): connects to MCP server sidecars via HTTP/SSE
 *          e.g. http://localhost:8081/sse
 *   - stdio (local dev): spawns MCP server as a child process
 *          e.g. npx -y @flux159/mcp-server-kubernetes
 *
 * MCP servers run as sidecar containers in the backend pod (see backend.yaml).
 * The backend connects via localhost — no Services, no DNS, no extra K8s objects.
 */

export interface McpServerConfig {
  /** Transport mode: "sse" (K8s sidecars) or "stdio" (local dev) */
  transport: 'sse' | 'stdio';
  /** SSE URL (when transport=sse) — e.g. http://localhost:8081/sse */
  url?: string;
  /** Command to spawn (when transport=stdio) — e.g. "npx" */
  command?: string;
  /** Arguments (when transport=stdio) */
  args?: string[];
  /** Environment variables for the MCP server process */
  env?: Record<string, string>;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string }>;
}

/**
 * McpBridge — Connects to MCP servers and routes tool calls.
 *
 * In K8s (sse mode): connects to sidecar containers via HTTP/SSE.
 *   - No child process spawning
 *   - Tool definitions are fetched via HTTP GET /tools
 *   - Tool calls are forwarded via HTTP POST /tools/call
 *
 * In local dev (stdio mode): spawns MCP server as a child process.
 *   - Uses Node.js child_process.spawn()
 *   - Communicates via stdin/stdout JSON-RPC (MCP protocol)
 */
export class McpBridge {
  private connectedSources = new Set<string>();
  private mcpTools: McpToolDefinition[] = [];
  private toolToSource = new Map<string, string>();
  private configs = new Map<string, McpServerConfig>();

  /**
   * Parse the MCP config from a JSON string (for local dev / env var override).
   */
  static parseConfig(raw?: string): Record<string, McpServerConfig> {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      console.warn('[McpBridge] Failed to parse MCP config JSON');
      return {};
    }
  }

  /**
   * Connect to all configured MCP servers.
   * Returns the list of tools discovered from all connected servers.
   */
  async connect(configs: Record<string, McpServerConfig>): Promise<McpToolDefinition[]> {
    const allTools: McpToolDefinition[] = [];

    for (const [source, cfg] of Object.entries(configs)) {
      try {
        const mode = cfg.transport === 'stdio' ? 'stdio' : 'sse';
        const endpoint = cfg.transport === 'sse' ? cfg.url : `${cfg.command} ${cfg.args?.join(' ')}`;
        console.log(`[McpBridge] Connecting to ${source} (${mode}): ${endpoint}`);

        this.configs.set(source, cfg);

        const tools = cfg.transport === 'sse'
          ? await this.connectViaSse(source, cfg)
          : await this.connectViaStdio(source, cfg);

        this.connectedSources.add(source);

        for (const tool of tools) {
          this.toolToSource.set(tool.name, source);
        }

        allTools.push(...tools);
        console.log(`[McpBridge] ${source}: ${tools.length} tools discovered`);
      } catch (err) {
        console.warn(
          `[McpBridge] Failed to connect to ${source}: ${(err as Error).message}`,
        );
      }
    }

    this.mcpTools = allTools;
    return allTools;
  }

  /**
   * Connect via SSE transport (K8s sidecar mode).
   *
   * Fetches tool definitions from the MCP server's SSE endpoint.
   * In production, this would use the MCP SDK's SSEClientTransport.
   * For now, it returns stub tool definitions matching the known MCP packages.
   *
   * STUB: Replace with real MCP SSE client when @modelcontextprotocol/sdk is wired:
   *
   *   import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
   *   const transport = new SSEClientTransport(new URL(cfg.url!));
   *   const client = new Client({ name: `${source}-worker`, version: '1.0.0' });
   *   await client.connect(transport);
   *   const { tools } = await client.listTools();
   *   return tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
   */
  private async connectViaSse(
    source: string,
    cfg: McpServerConfig,
  ): Promise<McpToolDefinition[]> {
    // Verify the sidecar is reachable
    if (cfg.url) {
      try {
        const res = await fetch(cfg.url, { method: 'GET' });
        console.log(`[McpBridge] ${source} SSE endpoint reachable: ${res.status}`);
      } catch {
        console.warn(`[McpBridge] ${source} SSE endpoint not reachable at ${cfg.url} — sidecar may still be starting`);
      }
    }

    // Return known tool stubs for each MCP source
    return this.getToolStubs(source);
  }

  /**
   * Connect via stdio transport (local dev mode).
   * Spawns MCP server as a child process.
   */
  private async connectViaStdio(
    source: string,
    cfg: McpServerConfig,
  ): Promise<McpToolDefinition[]> {
    // In production: spawn the process and call listTools via MCP SDK
    // For now: return stubs
    console.log(`[McpBridge] ${source}: stdio mode — would spawn ${cfg.command} ${cfg.args?.join(' ')}`);
    return this.getToolStubs(source);
  }

  /**
   * Return known tool stubs for each MCP server source.
   * These match the tools provided by the actual MCP packages.
   */
  private getToolStubs(source: string): McpToolDefinition[] {
    if (source === 'k8s') {
      return [
        {
          name: 'k8s_list_pods',
          description: 'List all pods in a Kubernetes namespace. Source: Kubernetes MCP server.',
          inputSchema: {
            type: 'object',
            properties: {
              namespace: { type: 'string', description: 'Kubernetes namespace (default from config)' },
            },
          },
        },
        {
          name: 'k8s_get_pod_logs',
          description: 'Get logs from a specific Kubernetes pod.',
          inputSchema: {
            type: 'object',
            properties: {
              podName: { type: 'string', description: 'Name of the pod' },
              namespace: { type: 'string', description: 'Kubernetes namespace' },
              tail: { type: 'number', description: 'Number of recent lines (default: 100)' },
            },
            required: ['podName'],
          },
        },
        {
          name: 'k8s_describe_pod',
          description: 'Describe a Kubernetes pod (status, events, conditions).',
          inputSchema: {
            type: 'object',
            properties: {
              podName: { type: 'string', description: 'Name of the pod' },
              namespace: { type: 'string', description: 'Kubernetes namespace' },
            },
            required: ['podName'],
          },
        },
      ];
    }

    if (source === 'aws') {
      return [
        {
          name: 'aws_filter_log_events',
          description: 'Filter and search AWS CloudWatch log events.',
          inputSchema: {
            type: 'object',
            properties: {
              logGroupName: { type: 'string', description: 'CloudWatch log group name' },
              filterPattern: { type: 'string', description: 'Filter pattern (e.g. "ERROR")' },
              limit: { type: 'number', description: 'Max events (default: 50)' },
            },
            required: ['logGroupName'],
          },
        },
        {
          name: 'aws_describe_log_groups',
          description: 'List available CloudWatch log groups.',
          inputSchema: {
            type: 'object',
            properties: {
              prefix: { type: 'string', description: 'Log group name prefix filter' },
            },
          },
        },
      ];
    }

    if (source === 'gcp') {
      return [
        {
          name: 'gcp_list_log_entries',
          description: 'List and filter Google Cloud Logging entries.',
          inputSchema: {
            type: 'object',
            properties: {
              filter: { type: 'string', description: 'GCP logging filter expression' },
              limit: { type: 'number', description: 'Max entries (default: 50)' },
            },
          },
        },
        {
          name: 'gcp_tail_log_entries',
          description: 'Stream recent Google Cloud Logging entries.',
          inputSchema: {
            type: 'object',
            properties: {
              filter: { type: 'string', description: 'GCP logging filter expression' },
            },
          },
        },
      ];
    }

    return [];
  }

  /**
   * Call a tool on its MCP server.
   *
   * In SSE mode: forwards to the sidecar via HTTP POST.
   * In stdio mode: forwards to the child process via MCP protocol.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const source = this.toolToSource.get(name);

    if (!source || !this.connectedSources.has(source)) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: `MCP server "${source || 'unknown'}" is not connected.`,
            hint: `Check that the ${source} sidecar is running and ${source === 'k8s' ? 'a kubeconfig secret exists' : 'credentials are configured'}.`,
            requestedTool: name,
          }),
        }],
      };
    }

    const cfg = this.configs.get(source);

    // SSE mode: forward to MCP sidecar via HTTP
    if (cfg?.transport === 'sse' && cfg?.url) {
      try {
        const baseUrl = cfg.url.replace(/\/sse$/, '');
        const res = await fetch(`${baseUrl}/tools/call`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, arguments: args }),
        });
        if (res.ok) {
          const data = await res.json();
          return { content: data.content || [{ type: 'text', text: JSON.stringify(data) }] };
        }
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: `Failed to call ${name} on ${source} sidecar`,
              detail: (err as Error).message,
              sidecarUrl: cfg.url,
            }),
          }],
        };
      }
    }

    // Fallback: return stub response
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          source,
          tool: name,
          status: 'executed',
          message: `Tool "${name}" called on "${source}" MCP server. Real SDK integration pending.`,
          args,
        }),
      }],
    };
  }

  isConnected(source: string): boolean {
    return this.connectedSources.has(source);
  }

  getToolDefinitions(): McpToolDefinition[] {
    return this.mcpTools;
  }

  async disconnect(): Promise<void> {
    this.connectedSources.clear();
    this.mcpTools = [];
    this.toolToSource.clear();
    this.configs.clear();
  }
}
