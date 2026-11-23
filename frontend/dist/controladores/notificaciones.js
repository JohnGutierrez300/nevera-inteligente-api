function createNotificationSound() {
  const Audio = window.AudioContext ?? window.webkitAudioContext;
  let context;
  let queued = false;

  function playPending() {
    if (!queued || document.hidden || context?.state !== 'running') return;
    queued = false;
    try {
      const start = context.currentTime + .015;
      for (const [offset, frequency] of [[0, 740], [.12, 988]]) {
        const time = start + offset;
        const note = context.createOscillator();
        const volume = context.createGain();
        note.frequency.value = frequency;
        volume.gain.setValueAtTime(0, time);
        volume.gain.linearRampToValueAtTime(.085, time + .014);
        volume.gain.exponentialRampToValueAtTime(.001, time + .16);
        note.connect(volume);
        volume.connect(context.destination);
        note.onended = () => { note.disconnect(); volume.disconnect(); };
        note.start(time);
        note.stop(time + .17);
      }
    } catch {
      // El aviso visual sigue disponible si el dispositivo bloquea el audio.
    }
  }

  document.addEventListener('visibilitychange', playPending);

  return {
    enable() {
      if (!Audio || document.hidden) return;
      try {
        if (!context || context.state === 'closed') context = new Audio();
        if (context.state === 'running') playPending();
        else void context.resume().then(playPending).catch(() => {});
      } catch {
        // Una interacción posterior puede volver a intentar habilitar el audio.
      }
    },
    queue() {
      queued = true;
      playPending();
    },
    clear() { queued = false; }
  };
}

function rememberedIds(key) {
  try {
    const ids = JSON.parse(localStorage.getItem(key));
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return new Set();
  }
}

export function createNotificationAlerts({ showUnread, announce }) {
  const sound = createNotificationSound();
  let key;
  let known = new Set();

  return {
    start(accountId) {
      key = `nevera.notificaciones.${accountId}`;
      known = rememberedIds(key);
    },
    sync(items) {
      if (!key) return;
      const unread = items.filter(item => !item.leida);
      showUnread(unread.length);
      if (!unread.length) sound.clear();
      if (document.hidden) return;

      const newItems = items.filter(item => !known.has(item._id));
      if (!newItems.length && items.length === known.size) return;
      const shared = rememberedIds(key);
      const fresh = newItems.filter(item => !item.leida && !shared.has(item._id));
      known = new Set(items.map(item => item._id));
      try {
        localStorage.setItem(key, JSON.stringify([...known]));
      } catch {
        // La pestaña conserva los IDs observados en memoria.
      }
      if (!fresh.length) return;
      announce(fresh);
      sound.queue();
    },
    enableSound: sound.enable,
    stop() {
      key = undefined;
      known.clear();
      sound.clear();
    }
  };
}
