export interface WebhookCall {
  url: string;
  body: string;
  at: string;
}

/**
 * Local-only webhook destination used by the demo. It deliberately never
 * performs network I/O; an allowed call is recorded in memory for evidence.
 */
export class MockWebhookSink {
  private readonly recorded: WebhookCall[] = [];

  readonly send = async (
    url: string,
    body: string,
  ): Promise<{ status: number }> => {
    this.recorded.push({ url, body, at: new Date().toISOString() });
    return { status: 202 };
  };

  calls(): WebhookCall[] {
    return structuredClone(this.recorded);
  }
}
