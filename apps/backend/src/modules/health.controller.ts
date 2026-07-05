import { Controller, Get } from '@nestjs/common';

/**
 * HealthController — K8s liveness/readiness probe endpoint.
 *
 * Returns 200 OK when the process is accepting connections.
 * For deeper health (DB + Redis connectivity), implement a health check service.
 */
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }
}
