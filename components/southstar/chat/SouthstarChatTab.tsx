export function SouthstarChatTab() {
  return (
    <section className="ss-chat-tab">
      <div className="ss-chat-empty">
        <h1>General conversation</h1>
        <p>Use chat for freeform work, brainstorming, and skill-guided Southstar planning. Start with <code>/workflow</code> when you want Southstar to design a workflow.</p>
        <div className="ss-chat-input-shell">
          <label htmlFor="southstar-chat-message">Message</label>
          <textarea id="southstar-chat-message" aria-describedby="chat-helper" />
          <p id="chat-helper">Ask a question or use a Southstar skill command.</p>
        </div>
      </div>
    </section>
  );
}
