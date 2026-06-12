export function RuntimeMonitor() {
  return (
    <section className="ss-panel ss-runtime" data-panel="runtime-monitor" id="runtime-monitor">
      <header>
        <h2>Runtime Monitor</h2>
        <span>SSE + polling</span>
      </header>
      <table>
        <tbody>
          <tr>
            <td>executor.submitted</td>
            <td>tork/job queued</td>
          </tr>
          <tr>
            <td>progress.commentary</td>
            <td>implementer running tests</td>
          </tr>
          <tr>
            <td>evaluator.completed</td>
            <td>root gate passed</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
