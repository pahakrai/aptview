import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { McpBridge, type McpServerConfig } from '../log-analyzer/mcp-bridge';

/**
 * MCP auto-discovery: probes an MCP server (SSE or stdio) and returns the list
 * of tools it exposes, so the design UI can show read-only capabilities.
 */
@Controller('mcp')
export class McpDiscoveryController {
  @Post('discover')
  @UseGuards(AuthGuard('api-key'))
  async discover(
    @Body()
    body: {
      name?: string;
      transport?: 'sse' | 'stdio';
      url?: string;
      command?: string;
      args?: string;
      env?: Record<string, string>;
    },
  ) {
    const source = body.name?.trim() || 'probe';
    let config: McpServerConfig | null = null;

    if (body.transport === 'stdio') {
      if (body.command) {
        config = {
          transport: 'stdio',
          command: body.command,
          args: body.args ? body.args.split(' ') : [],
          ...(body.env ? { env: body.env } : {}),
        };
      }
    } else if (body.url) {
      config = { transport: 'sse', url: body.url, ...(body.env ? { env: body.env } : {}) };
    }

    if (!config) {
      return { name: source, error: 'Provide a url (sse) or command (stdio).', tools: [], toolCount: 0 };
    }

    const bridge = new McpBridge();
    try {
      const tools = await bridge.connect({ [source]: config });
      return {
        name: source,
        transport: config.transport,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema ?? {},
        })),
        toolCount: tools.length,
      };
    } catch (err) {
      return { name: source, transport: config.transport, error: (err as Error).message, tools: [], toolCount: 0 };
    } finally {
      await bridge.disconnect();
    }
  }
}
