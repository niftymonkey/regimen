/**
 * The recording Exporter adapter: captures payloads in memory instead of
 * delivering them. Tests assert against what the daemon would have sent.
 */
import type { Exporter, OtlpPayload, SendResult } from "./port.ts";

export interface RecordingExporter extends Exporter {
  /** Every payload passed to `send`, in call order. */
  readonly sent: OtlpPayload[];
}

/** An Exporter that records payloads instead of delivering them. */
export function recordingExporter(): RecordingExporter {
  const sent: OtlpPayload[] = [];
  return {
    sent,
    send(payload: OtlpPayload): Promise<SendResult> {
      sent.push(payload);
      return Promise.resolve({ ok: true });
    },
  };
}
