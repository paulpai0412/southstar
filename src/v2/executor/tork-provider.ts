import type { ExecutorProvider, ExecutorSubmitRequest, ExecutorSubmitResult } from "./provider.ts";
import type { TorkClient } from "./tork-client.ts";
import { buildTorkJobProjection } from "./tork-projection.ts";

export type TorkExecutorProviderOptions = {
  torkClient: Pick<TorkClient, "submit">;
  callbackUrl?: string;
  heartbeatUrl?: string;
  liveEventUrl?: string;
  envelopeBasePath?: string;
};

export class TorkExecutorProvider implements ExecutorProvider {
  readonly executorType = "tork" as const;
  private readonly torkClient: Pick<TorkClient, "submit">;
  private readonly callbackUrl?: string;
  private readonly heartbeatUrl?: string;
  private readonly liveEventUrl?: string;
  private readonly envelopeBasePath?: string;

  constructor(options: TorkExecutorProviderOptions) {
    this.torkClient = options.torkClient;
    this.callbackUrl = options.callbackUrl;
    this.heartbeatUrl = options.heartbeatUrl;
    this.liveEventUrl = options.liveEventUrl;
    this.envelopeBasePath = options.envelopeBasePath;
  }

  async submit(request: ExecutorSubmitRequest): Promise<ExecutorSubmitResult> {
    const callbackUrl = request.callbackUrl ?? this.callbackUrl;
    if (!callbackUrl) throw new Error("TorkExecutorProvider requires callbackUrl");
    const envelopeBasePath = request.envelopeBasePath ?? this.envelopeBasePath ?? "/southstar-runs";
    const projection = buildTorkJobProjection(request.workflow, {
      callbackUrl,
      heartbeatUrl: request.heartbeatUrl ?? this.heartbeatUrl,
      liveEventUrl: request.liveEventUrl ?? this.liveEventUrl,
      envelopeBasePath,
      runId: request.runId,
      attemptId: request.attemptId,
    });
    const tork = await this.torkClient.submit(projection);
    return {
      executorType: "tork",
      externalJobId: tork.jobId,
      status: tork.status,
      projectionFingerprint: projection.fingerprint,
      executionProjection: projection,
      providerPayload: { torkJobId: tork.jobId },
    };
  }
}
