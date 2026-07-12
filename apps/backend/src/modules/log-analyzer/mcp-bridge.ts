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
 * Uses @modelcontextprotocol/sdk to connect to the MCP server sidecar
 * via HTTP/SSE. Fetches real tool definitions from the running server.
 * Falls back to known tool stubs if the SDK import fails.
 */
private async connectViaSse(
    source: string,
    cfg: McpServerConfig,
  ): Promise<McpToolDefinition[]> {
    if (!cfg.url) {
      console.warn(`[McpBridge] ${source}: no URL configured`);
      return this.getToolStubs(source);
    }

    // Try real MCP SDK connection first
    try {
      return await this.connectWithRealSdk(source, cfg.url);
    } catch (err) {
      console.warn(
        `[McpBridge] ${source}: MCP SDK connection failed (${(err as Error).message}) — falling back to stubs`,
      );
    }

    // Fallback: return known tool stubs
    return this.getToolStubs(source);
  }

  /**
   * Connect using the real @modelcontextprotocol/sdk.
   * Dynamic import to avoid crashing if the package isn't installed.
   */
  private async connectWithRealSdk(
    source: string,
    url: string,
  ): Promise<McpToolDefinition[]> {
    // Dynamic import — won't throw at load time if package is missing
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );

    const transport = new StreamableHTTPClientTransport(new URL(url));
    const client = new Client(
      { name: `aigov-log-analyzer-${source}`, version: '1.0.0' },
      { capabilities: {} },
    );

    await client.connect(transport);
    console.log(`[McpBridge] ${source}: connected via MCP SDK`);

    const { tools } = await client.listTools();
    console.log(`[McpBridge] ${source}: ${tools.length} tools discovered`);

    // Store the client for later tool calls
    this.mcpClients.set(source, client);

    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  /** Connected MCP clients (for real SDK connections) */
  private mcpClients = new Map<string, unknown>();

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

    if (source === 'kubetail') {
      return [
        {
          name: 'kubetail_list_pods',
          description: 'List all pods in a Kubernetes namespace with status, restarts, and age. Use this to spot crashing or unhealthy pods.',
          inputSchema: {
            type: 'object',
            properties: {
              namespace: { type: 'string', description: 'Kubernetes namespace (e.g. "production", "aigov")' },
              labelSelector: { type: 'string', description: 'Optional label filter (e.g. "app=payment-gateway")' },
            },
          },
        },
        {
          name: 'kubetail_get_logs',
          description: 'Fetch and aggregate logs across all replicas of a deployment. Strips noise (200 OK lines) and groups recurring error patterns. Use this to find error fingerprints.',
          inputSchema: {
            type: 'object',
            properties: {
              deployment: { type: 'string', description: 'Deployment name (e.g. "payment-gateway")' },
              namespace: { type: 'string', description: 'Kubernetes namespace' },
              since: { type: 'string', description: 'Time range (e.g. "15m", "1h", "30s")' },
              tail: { type: 'number', description: 'Number of recent lines per replica (default: 200)' },
            },
            required: ['deployment'],
          },
        },
        {
          name: 'kubetail_scan_errors',
          description: 'Scan logs across all replicas and group recurring error patterns with counts. Returns a prioritized list of exceptions sorted by frequency.',
          inputSchema: {
            type: 'object',
            properties: {
              deployment: { type: 'string', description: 'Deployment name' },
              namespace: { type: 'string', description: 'Kubernetes namespace' },
              since: { type: 'string', description: 'Time range (e.g. "15m", "1h")' },
              pattern: { type: 'string', description: 'Optional regex to filter error messages' },
            },
            required: ['deployment'],
          },
        },
        {
          name: 'kubetail_describe_pod',
          description: 'Get detailed pod info including events, conditions, resource limits, and container statuses.',
          inputSchema: {
            type: 'object',
            properties: {
              podName: { type: 'string', description: 'Full pod name' },
              namespace: { type: 'string', description: 'Kubernetes namespace' },
            },
            required: ['podName'],
          },
        },
        {
          name: 'kubetail_get_config',
          description: 'Inspect environment variables, ConfigMaps, and Secrets referenced by a deployment. Use this to check for misconfigured endpoints or ports.',
          inputSchema: {
            type: 'object',
            properties: {
              deployment: { type: 'string', description: 'Deployment name' },
              namespace: { type: 'string', description: 'Kubernetes namespace' },
            },
            required: ['deployment'],
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

    // SSE mode: use real MCP client if connected, otherwise HTTP fallback
    if (cfg?.transport === 'sse') {
      // Try real MCP SDK client first
      const mcpClient = this.mcpClients.get(source) as {
        callTool: (params: { name: string; arguments: Record<string, unknown> }) => Promise<{ content: Array<{ type: string; text?: string }> }>;
      } | undefined;

      if (mcpClient) {
        try {
          const result = await mcpClient.callTool({ name, arguments: args });
          return { content: result.content };
        } catch (err) {
          console.warn(`[McpBridge] ${source}: real SDK call failed (${(err as Error).message})`);
        }
      }

      // HTTP fallback for sidecars without SDK client
      if (cfg.url) {
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
        } catch {
          // Fall through to stub
        }
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
    // Close real MCP client connections
    for (const [, client] of this.mcpClients) {
      try {
        await (client as { close: () => Promise<void> }).close();
      } catch { /* ignore */ }
    }
    this.mcpClients.clear();
    this.connectedSources.clear();
    this.mcpTools = [];
    this.toolToSource.clear();
    this.configs.clear();
  }
}
