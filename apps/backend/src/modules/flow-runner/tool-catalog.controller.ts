import { Controller, Get } from '@nestjs/common';
import { listSkillNames, REVIEW_SKILLS } from './tool-catalog';

/** Known MCP server source names the orchestrator can connect (via env config). */
const MCP_SERVERS = ['k8s', 'aws', 'gcp', 'kubetail'];

@Controller('tool-catalog')
export class ToolCatalogController {
  @Get()
  list() {
    return {
      skills: REVIEW_SKILLS.map((s) => ({
        name: s.name,
        description: s.description,
        parameters: s.parameters,
      })),
      mcp: MCP_SERVERS,
      skillNames: listSkillNames(),
    };
  }
}
