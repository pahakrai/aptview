import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ReviewsService } from './reviews.service';
import { ReviewsController } from './reviews.controller';
import { ReviewProcessor } from './review.processor';
import { ReviewCommenter } from './review-commenter';

@Module({
  imports: [
    ConfigModule,
    BullModule.registerQueue({
      name: 'reviews',
    }),
  ],
  controllers: [ReviewsController],
  providers: [ReviewsService, ReviewProcessor, ReviewCommenter],
  exports: [ReviewsService, ReviewCommenter],
})
export class ReviewsModule {}
