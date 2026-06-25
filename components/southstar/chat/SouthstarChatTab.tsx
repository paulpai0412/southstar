import type { SouthstarApiClient } from "@/lib/southstar/api-client";
import { ChatTranscriptPanel } from "./ChatTranscriptPanel";

export function SouthstarChatTab(props: {
  api?: SouthstarApiClient;
  serverBaseUrl?: string;
  selectedRunId?: string | null;
  selectedSessionId?: string | null;
}) {
  if (!props.api || !props.serverBaseUrl) {
    return (
      <section className="ss-chat-tab">
        <p className="ss-empty">Chat workspace requires Southstar API binding.</p>
      </section>
    );
  }
  return (
    <section className="ss-chat-tab">
      <ChatTranscriptPanel
        api={props.api}
        serverBaseUrl={props.serverBaseUrl}
        selectedRunId={props.selectedRunId ?? null}
        selectedSessionId={props.selectedSessionId ?? null}
      />
    </section>
  );
}
