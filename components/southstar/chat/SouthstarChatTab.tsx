import type { SouthstarApiClient } from "@/lib/southstar/api-client";
import { ChatTranscriptPanel } from "./ChatTranscriptPanel";
import { SouthstarNativeChatWorkspace } from "./SouthstarNativeChatWorkspace";

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
      <SouthstarNativeChatWorkspace
        api={props.api}
        selectedRunId={props.selectedRunId ?? null}
        selectedSessionId={props.selectedSessionId ?? null}
        onRuntimeStatusChange={() => {}}
      />
      <aside className="ss-runtime-transcript-panel" aria-label="Runtime transcript">
        <header>
          <h2>Runtime transcript</h2>
          <span>Southstar runtime stream</span>
        </header>
        <ChatTranscriptPanel
          api={props.api}
          serverBaseUrl={props.serverBaseUrl}
          selectedRunId={props.selectedRunId ?? null}
          selectedSessionId={props.selectedSessionId ?? null}
        />
      </aside>
    </section>
  );
}
