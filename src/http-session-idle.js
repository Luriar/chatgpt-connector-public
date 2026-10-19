// Session retention for stateful Streamable HTTP. A closed SSE GET stream is not
// equivalent to an MCP DELETE: clients may reconnect with the same session ID.
export function createSessionIdleReaper({
  idleMs = 30 * 60_000,
  sweepMs = 60_000,
  now = () => Date.now(),
  onExpire = () => {},
  onError = () => {}
} = {}) {
  idleMs = Math.max(100, Number(idleMs) || 30 * 60_000);
  sweepMs = Math.max(25, Number(sweepMs) || 60_000);
  const sessions = new Map();

  function register(id, transport) {
    sessions.set(id, { transport, lastActivity: now(), activeRequests: 0, closing: false });
  }
  function unregister(id, transport) {
    if (sessions.get(id)?.transport === transport) sessions.delete(id);
  }
  function isClosing(id) {
    return sessions.get(id)?.closing === true;
  }
  function trackRequest(id, req, res) {
    const session = sessions.get(id);
    if (!session || session.closing) return;
    session.lastActivity = now();
    session.activeRequests++;
    let settled = false;
    const complete = () => {
      if (settled) return;
      settled = true;
      session.activeRequests = Math.max(0, session.activeRequests - 1);
      session.lastActivity = now();
      res.off("finish", complete);
      res.off("close", complete);

    };
    res.once("finish", complete);
    res.once("close", complete);
    // A partial request abort is not proof a running handler has finished.
  }
  async function sweep() {
    const retired = [];
    for (const [id, session] of sessions) {
      if (session.closing || session.activeRequests > 0 || now() - session.lastActivity < idleMs) continue;
      session.closing = true;
      retired.push(Promise.resolve().then(() => session.transport.close()).then(() => {
        unregister(id, session.transport);
        onExpire(id);
      }).catch(error => {
        session.closing = false;
        session.lastActivity = now();
        onError(error);
      }));
    }
    await Promise.all(retired);
  }
  const timer = setInterval(() => { void sweep().catch(onError); }, sweepMs);
  timer.unref?.();
  return {
    register, unregister, isClosing, trackRequest, sweep,
    stop() { clearInterval(timer); },
    count() { return sessions.size; }
  };
}
