import { Module } from '@nestjs/common';
import { StandardsService } from './standards.service';
import { StandardsController } from './standards.controller';

@Module({
  controllers: [StandardsController],
  providers: [StandardsService],
  exports: [StandardsService],
})
export class StandardsModule {}
