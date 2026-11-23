const reportIntervalMs = 5_000;
const interactionBatchMs = 100;

export function createIdleTimer({ report, check, onExpired }) {
  let current;

  function stop() {
    if (!current) return;
    clearTimeout(current.expiryTimer);
    clearTimeout(current.reportTimer);
    current = undefined;
  }

  function update(session, remainingMs) {
    if (current !== session) return;
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      stop();
      onExpired();
      return;
    }
    session.deadline = Date.now() + remainingMs;
    scheduleExpiry(session);
  }

  function scheduleExpiry(session) {
    clearTimeout(session.expiryTimer);
    session.expiryTimer = setTimeout(() => void checkExpiry(session), Math.max(0, session.deadline - Date.now()));
  }

  async function checkExpiry(session) {
    if (!session || current !== session || session.checking) return;
    if (Date.now() < session.deadline) {
      scheduleExpiry(session);
      return;
    }
    // Otra pestaña puede haber actualizado el plazo de la misma sesión.
    session.checking = true;
    let remainingMs = 0;
    try {
      remainingMs = await check(session.accountId);
    } catch {
      // Al llegar al plazo, la vista necesita una confirmación vigente del servidor.
    }
    session.checking = false;
    update(session, remainingMs);
  }

  async function sendActivity(session) {
    if (!session || current !== session || session.interactionAt === undefined) return;
    clearTimeout(session.reportTimer);
    session.reportTimer = undefined;
    session.reportedAt = Date.now();
    const elapsed = Math.max(0, session.reportedAt - session.interactionAt);
    session.interactionAt = undefined;
    try {
      update(session, await report(elapsed));
    } catch {
      // Una llamada fallida deja vigente el último plazo confirmado.
    }
  }

  function interact(event) {
    if (!current || !event.isTrusted || document.hidden) return;
    const session = current;
    const now = Date.now();
    if (now >= session.deadline) {
      void checkExpiry(session);
      return;
    }
    session.interactionAt = now;
    if (session.reportTimer !== undefined) return;
    const delay = Math.max(interactionBatchMs, session.reportedAt + reportIntervalMs - now);
    if (session.deadline - now <= delay) void sendActivity(session);
    else session.reportTimer = setTimeout(() => void sendActivity(session), delay);
  }

  for (const event of ['pointerdown', 'keydown', 'input', 'wheel', 'click']) {
    window.addEventListener(event, interact, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void sendActivity(current);
    else void checkExpiry(current);
  });
  window.addEventListener('pageshow', () => void checkExpiry(current));
  window.addEventListener('pagehide', () => void sendActivity(current));

  return {
    start(accountId, remainingMs) {
      stop();
      current = { accountId, reportedAt: -Infinity };
      update(current, remainingMs);
    },
    get expired() { return !!current && Date.now() >= current.deadline; },
    stop
  };
}
