import { metricSnapshotSchema, type MetricSnapshot } from "@pve-vm-autoscaler/shared";

export interface MetricsClientOptions {
  serverUrl: string;
  token: string;
}

export class MetricsClient {
  constructor(private readonly options: MetricsClientOptions) {}

  async send(snapshot: MetricSnapshot): Promise<void> {
    const body = metricSnapshotSchema.parse(snapshot);
    const response = await fetch(`${this.options.serverUrl}/v1/metrics`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${this.options.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Metrics ingestion failed: ${response.status} ${text}`);
    }
  }
}
