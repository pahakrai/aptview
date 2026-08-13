import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ReviewsService } from './reviews.service';
import { ReviewsController } from './reviews.controller';
import { ReviewProcessor } from './review.processor';
import { ReviewCommenter } from './review-commenter';
import { ExperimentsModule } from '../experiments/experiments.module';

@Module({
  imports: [
    ConfigModule,
    BullModule.registerQueue({
      name: 'reviews',
    }),
    ExperimentsModule,
  ],
  controllers: [ReviewsController],
  providers: [ReviewsService, ReviewProcessor, ReviewCommenter],
  exports: [ReviewsService, ReviewCommenter],
})
export class ReviewsModule {}
