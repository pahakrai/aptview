import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuthModule } from './modules/auth/auth.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { RepositoriesModule } from './modules/repositories/repositories.module';
import { AuditsModule } from './modules/audits/audits.module';
import { DecompositionModule } from './modules/decomposition/decomposition.module';
import { StandardsModule } from './modules/standards/standards.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { HealthController } from './modules/health.controller';

@Module({
  imports: [
    // Global configuration
    ConfigModule.forRoot({ isGlobal: true }),

    // Redis-backed job queue (BullMQ)
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
      },
    }),

    // Rate limiting
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 100,
      },
    ]),

    // Feature modules
    AuthModule,
    OrganizationsModule,
    RepositoriesModule,
    AuditsModule,
    DecompositionModule,
    StandardsModule,
    WebhooksModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
