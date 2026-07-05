import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WebhooksService } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { GitHubService } from './github.service';
import { AuditsModule } from '../audits/audits.module';

@Module({
  imports: [ConfigModule, AuditsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, GitHubService],
})
export class WebhooksModule {}
