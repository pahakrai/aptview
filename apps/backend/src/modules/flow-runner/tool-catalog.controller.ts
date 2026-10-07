import { Controller, Get } from '@nestjs/common';
import { listSkillNames, listTools, MCP_SOURCES, REVIEW_SKILLS } from './tool-catalog';

@Controller('tool-catalog')
export class ToolCatalogController {
  @Get()
  list() {
    return {
      skills: REVIEW_SKILLS.map((s) => ({
        kind: s.kind,
        name: s.name,
        description: s.description,
        configSchema: s.configSchema,
        parameters: s.parameters,
      })),
      mcp: MCP_SOURCES.map((m) => ({
        kind: m.kind,
        name: m.name,
        description: m.description,
        configSchema: m.configSchema,
      })),
      skillNames: listSkillNames(),
      tools: listTools().map((t) => ({
        kind: t.kind,
        name: t.name,
        description: t.description,
        configSchema: t.configSchema,
      })),
    };
  }
}
