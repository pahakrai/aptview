import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  @Get(':key')
  async get(@Param('key') key: string) {
    return { key, value: await this.service.get(key) };
  }

  @Put(':key')
  @UseGuards(AuthGuard('api-key'))
  async set(@Param('key') key: string, @Body() body: { value: string }) {
    await this.service.set(key, body.value);
    return { key, value: body.value };
  }
}
