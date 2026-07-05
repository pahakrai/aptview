import { Controller, Get, Post, Patch, Param, Body } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { EnforcementMode } from '@aigov/shared-types';

@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly orgsService: OrganizationsService) {}

  @Post()
  create(@Body() body: { name: string; slug: string }) {
    return this.orgsService.create(body.name, body.slug);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.orgsService.getById(id);
  }

  @Get('slug/:slug')
  getBySlug(@Param('slug') slug: string) {
    return this.orgsService.getBySlug(slug);
  }

  @Patch(':id/enforcement')
  updateEnforcement(
    @Param('id') id: string,
    @Body() body: { mode: EnforcementMode; changedBy: string },
  ) {
    return this.orgsService.updateEnforcementMode(id, body.mode, body.changedBy);
  }
}
