import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { HeaderAPIKeyStrategy } from 'passport-headerapikey';
import { AuthService } from './auth.service';

@Injectable()
export class ApiKeyStrategy extends PassportStrategy(HeaderAPIKeyStrategy, 'api-key') {
  constructor(private readonly authService: AuthService) {
    super(
      { header: 'x-api-key', prefix: '' },
      true,
      async (apikey: string, done: (err: Error | null, user?: unknown) => void) => {
        const result = await this.authService.validateApiKey(apikey);
        if (!result) {
          return done(new UnauthorizedException('Invalid or revoked API key'), null);
        }
        return done(null, result);
      },
    );
  }
}
