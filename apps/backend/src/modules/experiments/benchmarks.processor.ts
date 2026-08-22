import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ExperimentsService } from './experiments.service';

export interface BenchmarkJobData {
  benchmarkJobId: string;
  experimentId: string;
  organizationId: string;
}

/**
 * BenchmarksProcessor — BullMQ worker for async deliberate benchmark runs.
 * Delegates the actual arm execution to ExperimentsService.runBenchmarkJob,
 * which tracks status in the benchmark_jobs table and writes notifications.
 */
@Processor('benchmarks')
export class BenchmarksProcessor extends WorkerHost {
  constructor(private readonly experimentsService: ExperimentsService) {
    super();
  }

  async process(job: Job<BenchmarkJobData>): Promise<void> {
    await this.experimentsService.runBenchmarkJob(job.data.benchmarkJobId);
  }
}
