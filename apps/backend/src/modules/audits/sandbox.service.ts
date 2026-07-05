import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  KubeConfig,
  BatchV1Api,
  CoreV1Api,
  V1Job,
  V1Pod,
  V1ObjectMeta,
  V1JobSpec,
  V1PodTemplateSpec,
  V1PodSpec,
  V1Container,
  V1ResourceRequirements,
  V1EnvVar,
  V1Volume,
  V1VolumeMount,
  V1SecurityContext,
} from '@kubernetes/client-node';
import { randomUUID } from 'crypto';

/**
 * SandboxService — Manages ephemeral Kubernetes Jobs for code review.
 *
 * Each audit spawns a single-run Job in the codewhale-runner namespace.
 * The Job runs the CodeWhale sandbox image with the audit prompt and
 * changed files as input. Output is captured from pod logs.
 */

export interface SandboxJobConfig {
  /** Unique job identifier (audit job ID) */
  jobId: string;
  /** The analysis prompt (diff + changed files + guidelines) */
  prompt: string;
  /** Container image tag (default: aigov-codewhale-runner:latest) */
  image?: string;
  /** Job TTL after completion, in seconds (default: 300) */
  ttlSecondsAfterFinished?: number;
  /** CPU limit in millicores (default: 1000m) */
  cpuLimit?: string;
  /** Memory limit (default: 256Mi) */
  memoryLimit?: string;
}

export interface SandboxJobResult {
  /** Whether the job completed successfully */
  success: boolean;
  /** Raw stdout/stderr from the pod */
  output: string;
  /** Parsed JSON result from CodeWhale (if output_format=json) */
  parsed?: unknown;
  /** Pod phase: Succeeded, Failed, etc. */
  phase: string;
  /** Time the job took, in milliseconds */
  durationMs: number;
}

@Injectable()
export class SandboxService implements OnModuleInit {
  private readonly logger = new Logger(SandboxService.name);
  private readonly namespace: string;
  private readonly defaultImage: string;

  private kc: KubeConfig;
  private batchApi: BatchV1Api;
  private coreApi: CoreV1Api;

  constructor(private readonly configService: ConfigService) {
    this.namespace =
      this.configService.get<string>('K8S_NAMESPACE') || 'codewhale-runner';
    this.defaultImage =
      this.configService.get<string>('K8S_RUNNER_IMAGE') ||
      'aigov-codewhale-runner:latest';
  }

  /**
   * Initialize the Kubernetes client. Uses in-cluster config when running
   * inside K8s, otherwise falls back to kubeconfig.
   */
  onModuleInit() {
    this.kc = new KubeConfig();

    try {
      this.kc.loadFromCluster();
      this.logger.log('Loaded in-cluster Kubernetes config');
    } catch {
      this.kc.loadFromDefault();
      this.logger.log('Loaded default kubeconfig');
    }

    this.batchApi = this.kc.makeApiClient(BatchV1Api);
    this.coreApi = this.kc.makeApiClient(CoreV1Api);
  }

  /**
   * Submit an audit analysis job to Kubernetes.
   *
   * Creates a Job, waits for it to complete, extracts logs, and returns
   * the structured result.
   */
  async runAudit(config: SandboxJobConfig): Promise<SandboxJobResult> {
    const startTime = Date.now();
    const {
      jobId,
      prompt,
      image = this.defaultImage,
      ttlSecondsAfterFinished = 300,
      cpuLimit = '1000m',
      memoryLimit = '256Mi',
    } = config;

    const jobName = this.sanitizeJobName(`audit-${jobId}`);
    this.logger.log(`Submitting audit job: ${jobName}`);

    // -----------------------------------------------------------------------
    // 1. Build Job manifest
    // -----------------------------------------------------------------------
    const job = this.buildJobManifest({
      jobName,
      prompt,
      image,
      ttlSecondsAfterFinished,
      cpuLimit,
      memoryLimit,
    });

    // -----------------------------------------------------------------------
    // 2. Create Job
    // -----------------------------------------------------------------------
    await this.batchApi.createNamespacedJob({
      namespace: this.namespace,
      body: job,
    });

    this.logger.log(`Job ${jobName} created`);

    // -----------------------------------------------------------------------
    // 3. Poll for completion
    // -----------------------------------------------------------------------
    const result = await this.waitForJob(jobName);

    const durationMs = Date.now() - startTime;
    result.durationMs = durationMs;

    this.logger.log(
      `Job ${jobName} finished: ${result.phase} in ${durationMs}ms`,
    );

    return result;
  }

  /**
   * Build the Kubernetes Job manifest.
   */
  private buildJobManifest(params: {
    jobName: string;
    prompt: string;
    image: string;
    ttlSecondsAfterFinished: number;
    cpuLimit: string;
    memoryLimit: string;
  }): V1Job {
    const {
      jobName,
      prompt,
      image,
      ttlSecondsAfterFinished,
      cpuLimit,
      memoryLimit,
    } = params;

    // Encode the prompt as base64 to avoid YAML escaping issues
    const promptBase64 = Buffer.from(prompt, 'utf-8').toString('base64');

    const metadata: V1ObjectMeta = {
      name: jobName,
      labels: {
        'app.kubernetes.io/name': 'codewhale-runner',
        'app.kubernetes.io/component': 'audit',
        'aigov.io/job-id': jobName,
      },
    };

    const container: V1Container = {
      name: 'runner',
      image,
      imagePullPolicy: 'IfNotPresent',
      env: [
        {
          name: 'AUDIT_PROMPT_BASE64',
          value: promptBase64,
        } as V1EnvVar,
        {
          name: 'CODEWHALE_MODEL',
          value: 'deepseek-v4-flash',
        } as V1EnvVar,
        {
          name: 'CODEWHALE_ALLOWED_TOOLS',
          value: 'read,grep',
        } as V1EnvVar,
        {
          name: 'CODEWHALE_OUTPUT_FORMAT',
          value: 'json',
        } as V1EnvVar,
      ],
      // Decode the prompt before running
      command: ['/bin/sh', '-c'],
      args: [
        'echo "$AUDIT_PROMPT_BASE64" | base64 -d > /workspace/audit_prompt.txt && codewhale --goal "$(cat /workspace/audit_prompt.txt)" --allowed-tools "$CODEWHALE_ALLOWED_TOOLS" --model "$CODEWHALE_MODEL" --output-format "$CODEWHALE_OUTPUT_FORMAT"',
      ],
      resources: {
        limits: {
          cpu: cpuLimit,
          memory: memoryLimit,
        },
        requests: {
          cpu: '100m',
          memory: '128Mi',
        },
      } as V1ResourceRequirements,
      securityContext: {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        runAsNonRoot: true,
        runAsUser: 1000,
        capabilities: {
          drop: ['ALL'],
        },
      } as V1SecurityContext,
      volumeMounts: [
        {
          name: 'workspace',
          mountPath: '/workspace',
        } as V1VolumeMount,
      ],
    };

    const podSpec: V1PodSpec = {
      restartPolicy: 'Never',
      containers: [container],
      volumes: [
        {
          name: 'workspace',
          emptyDir: {},
        } as V1Volume,
      ],
      // Do not automount the service account token — no API access needed
      automountServiceAccountToken: false,
    };

    const template: V1PodTemplateSpec = {
      metadata: {
        labels: {
          'app.kubernetes.io/name': 'codewhale-runner',
          'aigov.io/job-id': jobName,
        },
      },
      spec: podSpec,
    };

    const jobSpec: V1JobSpec = {
      ttlSecondsAfterFinished,
      backoffLimit: 0,
      template,
    };

    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata,
      spec: jobSpec,
    };
  }

  /**
   * Poll the Job and its pods until the Job reaches a terminal state.
   */
  private async waitForJob(jobName: string): Promise<SandboxJobResult> {
    const maxPollMs = 300_000; // 5 minutes
    const pollIntervalMs = 2_000;
    const deadline = Date.now() + maxPollMs;

    while (Date.now() < deadline) {
      const job = await this.batchApi.readNamespacedJob({
        namespace: this.namespace,
        name: jobName,
      });

      // Check completion
      if (job.status?.succeeded !== undefined && job.status.succeeded > 0) {
        const logs = await this.getPodLogs(jobName);
        return {
          success: true,
          output: logs,
          parsed: this.tryParseJson(logs),
          phase: 'Succeeded',
          durationMs: 0,
        };
      }

      if (job.status?.failed !== undefined && job.status.failed > 0) {
        const logs = await this.getPodLogs(jobName);
        return {
          success: false,
          output: logs,
          parsed: null,
          phase: 'Failed',
          durationMs: 0,
        };
      }

      // Still running — wait and retry
      await this.sleep(pollIntervalMs);
    }

    // Timed out — get whatever logs we can
    const logs = await this.getPodLogs(jobName);
    return {
      success: false,
      output: logs,
      parsed: null,
      phase: 'Timeout',
      durationMs: 0,
    };
  }

  /**
   * Fetch pod logs for a given job. Finds the first pod owned by the job.
   */
  private async getPodLogs(jobName: string): Promise<string> {
    try {
      const pods = await this.coreApi.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: `aigov.io/job-id=${jobName}`,
      });

      if (pods.items.length === 0) {
        return '';
      }

      const podName = pods.items[0].metadata?.name;
      if (!podName) return '';

      const logResponse = await this.coreApi.readNamespacedPodLog({
        namespace: this.namespace,
        name: podName,
      });

      return logResponse || '';
    } catch (err) {
      this.logger.warn(
        `Failed to fetch logs for job ${jobName}: ${(err as Error)?.message}`,
      );
      return '';
    }
  }

  /**
   * Attempt to parse a string as JSON. Returns null on failure.
   */
  private tryParseJson(raw: string): unknown {
    // Codewhale may emit non-JSON before the actual JSON (e.g. startup logs).
    // Find the first JSON object in the output.
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }

  /**
   * Sanitize a job name to meet Kubernetes naming requirements:
   * lowercase alphanumeric, '-', and '.' only; max 63 chars.
   */
  private sanitizeJobName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9.-]/g, '-')
      .slice(0, 63);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
