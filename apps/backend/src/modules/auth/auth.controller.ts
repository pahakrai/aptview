import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('api-keys')
  @HttpCode(HttpStatus.CREATED)
  async createApiKey(@Body() body: { organizationId: string; name: string }) {
    return this.authService.createApiKey(body.organizationId, body.name);
  }

  @Post('api-keys/revoke')
  @HttpCode(HttpStatus.OK)
  async revokeApiKey(@Body() body: { keyId: string }) {
    return this.authService.revokeApiKey(body.keyId);
  }
}
