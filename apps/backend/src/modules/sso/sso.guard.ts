import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { SsoService } from './sso.service';

/**
 * SsoGuard — protects routes by validating the injected Nginx headers.
 *
 * Nginx validates the JWT at the edge and injects plain-text headers:
 *   X-User-Id, X-User-Role, X-User-Department
 *
 * This guard verifies those headers exist. If they're missing, the request
 * bypassed Nginx and should be rejected.
 *
 * Usage: @UseGuards(SsoGuard) on a controller or route.
 */

@Injectable()
export class SsoGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = request.headers['x-user-id'];

    if (!userId) {
      throw new UnauthorizedException(
        'Bypassing gateway forbidden. No x-user-id header present.',
      );
    }

    // Attach user info to request for downstream use
    request.user = {
      id: userId,
      role: request.headers['x-user-role'] || 'user',
      department: request.headers['x-user-department'] || '',
    };

    return true;
  }
}
