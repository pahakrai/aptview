import { Controller, Get, Post, Patch, Param, Body } from '@nestjs/common';
import { RepositoriesService } from './repositories.service';

@Controller('repositories')
export class RepositoriesController {
  constructor(private readonly reposService: RepositoriesService) {}

  @Post()
  create(
    @Body() body: { organizationId: string; name: string; fullName: string; provider?: string },
  ) {
    return this.reposService.create(body);
  }

  @Get('org/:orgId')
  listByOrg(@Param('orgId') orgId: string) {
    return this.reposService.listByOrg(orgId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.reposService.getById(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { isActive?: boolean; webhookSecret?: string; reviewBranches?: string[] }) {
    return this.reposService.update(id, body);
  }
}
