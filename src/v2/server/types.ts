export type ApiEnvelope<T> = {
  ok: true;
  kind: string;
  result: T;
};

export type ApiErrorEnvelope = {
  ok: false;
  error: string;
};

export type ServerSentRunEvent = {
  id: string;
  sequence: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
};
