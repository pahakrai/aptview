import { Controller, Post, Headers, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  /**
   * GitHub PR webhook receiver.
   */
  @Post('github')
  @HttpCode(HttpStatus.ACCEPTED)
  async handleGitHub(
    @Headers('x-hub-signature-256') signature: string,
    @Headers('x-github-event') event: string,
    @Body() payload: Record<string, unknown>,
  ) {
    return this.webhooksService.processGitHubWebhook(event, payload, signature);
  }

  /**
   * Jira issue webhook receiver.
   */
  @Post('jira')
  @HttpCode(HttpStatus.ACCEPTED)
  async handleJira(@Body() payload: Record<string, unknown>) {
    return this.webhooksService.processJiraWebhook(payload);
  }

  /**
   * Linear issue webhook receiver.
   */
  @Post('linear')
  @HttpCode(HttpStatus.ACCEPTED)
  async handleLinear(@Body() payload: Record<string, unknown>) {
    return this.webhooksService.processLinearWebhook(payload);
  }
}
