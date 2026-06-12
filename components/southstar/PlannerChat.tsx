"use client";

export function PlannerChat() {
  return (
    <section className="ss-panel ss-planner" data-panel="planner-chat" id="planner-chat">
      <header>
        <h2>Planner Chat</h2>
        <select aria-label="input mode" defaultValue="goal">
          <option value="goal">Goal Prompt</option>
          <option value="steering">Steering</option>
          <option value="voice">Voice Transcript</option>
        </select>
      </header>
      <textarea
        aria-label="planner input"
        defaultValue="新增 calc sum <numbers...>，保留最小改動，不新增 runtime dependency。"
      />
      <div className="ss-actions">
        <button type="button">Send to Planner</button>
        <button type="button">Review Draft</button>
        <button type="button">Revise</button>
        <button type="button">Run</button>
      </div>
      <ol className="ss-timeline">
        <li>
          <strong>v1</strong>
          <span>Initial plan generated</span>
        </li>
        <li>
          <strong>voice</strong>
          <span>Voice Transcript: low-risk steering auto approved</span>
        </li>
      </ol>
    </section>
  );
}
