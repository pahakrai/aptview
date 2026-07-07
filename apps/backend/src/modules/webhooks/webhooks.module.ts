import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WebhooksService } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { GitHubService } from './github.service';
import { AuditsModule } from '../audits/audits.module';
import { ReviewsModule } from '../reviews/reviews.module';

@Module({
  imports: [ConfigModule, AuditsModule, ReviewsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, GitHubService],
})
export class WebhooksModule {}
