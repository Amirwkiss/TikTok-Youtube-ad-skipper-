(() => {
  const processed = new WeakMap();
  const spokenSkips = new WeakMap();
  const Speech = globalThis.SpeechRecognition;
  let speechMode = null;
  let cloudAllowed = false;
  let speechSession = null;
  let speechRetryAt = 0;
  let fingerprintSession = null;

  if (Speech?.available && 'processLocally' in Speech.prototype) {
    Speech.available({ langs: ['ru-RU'], processLocally: true })
      .then(async status => {
        if (status === 'available') speechMode = 'local';
        if (status === 'downloadable' && Speech.install) {
          if (await Speech.install({ langs: ['ru-RU'] })) speechMode = 'local';
        }
      })
      .catch(() => {});
  }
  chrome.storage.local.get('allowCloudSpeech').then(settings => {
    cloudAllowed = settings.allowCloudSpeech === true;
    if (cloudAllowed && !speechMode && Speech) speechMode = 'cloud';
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.allowCloudSpeech) return;
    cloudAllowed = changes.allowCloudSpeech.newValue === true;
    if (!cloudAllowed && speechMode === 'cloud') {
      speechMode = null;
      stopSpeech();
    } else if (cloudAllowed && !speechMode && Speech) speechMode = 'cloud';
  });

  function stopSpeech() {
    const session = speechSession;
    speechSession = null;
    if (!session) return;
    session.recognition.onend = null;
    session.recognition.onerror = null;
    session.recognition.onresult = null;
    try { session.recognition.abort(); } catch (_) {}
    session.track.stop();
  }

  function stopFingerprint() {
    const old = fingerprintSession;
    fingerprintSession = null;
    old?.matcher.stop();
    old?.track.stop();
  }

  function skipSpoken(video, key) {
    const last = spokenSkips.get(video);
    if (last?.key === key && video.currentTime < last.endTime + 4 && video.currentTime >= last.endTime - 4) {
      return { ok: false, reason: 'эта фраза уже пропущена несколько секунд назад' };
    }
    if (!AdDetector.seekFourSeconds(video)) {
      return { ok: false, reason: `перемотка недоступна (время ${video.currentTime}, длительность ${video.duration})` };
    }
    spokenSkips.set(video, { key, endTime: video.currentTime });
    stopSpeech();
    stopFingerprint();
    return { ok: true };
  }

  function listenForFingerprint(video, key) {
    if (!globalThis.AdAudioFingerprint || typeof video.captureStream !== 'function') return;
    if (fingerprintSession?.video === video && fingerprintSession.key === key) return;
    stopFingerprint();
    let stream;
    let track;
    try {
      stream = video.captureStream();
      track = stream.getAudioTracks().find(item => item.readyState === 'live');
    } catch (_) { return; }
    if (!track) return;
    const session = { video, key, track, matcher: null };
    session.matcher = AdAudioFingerprint.listen(stream, result => {
      if (fingerprintSession !== session || !visible(video) || video.paused || videoKey(video) !== key) return;
      if (skipSpoken(video, key).ok) console.debug('Ad skipper audio match', result.name, result.score, result.elapsedMs);
    });
    fingerprintSession = session;
  }

  function listenToVideo(video, key) {
    if (!speechMode || typeof video.captureStream !== 'function' || Date.now() < speechRetryAt) return;
    if (speechSession?.video === video && speechSession.key === key) return;
    stopSpeech();
    let track;
    try {
      track = video.captureStream().getAudioTracks().find(item => item.readyState === 'live');
    } catch (_) { return; }
    if (!track) return;
    const recognition = new Speech();
    recognition.lang = 'ru-RU';
    recognition.processLocally = speechMode === 'local';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;
    const session = { video, key, recognition, track };
    speechSession = session;
    recognition.onresult = event => {
      if (speechSession !== session || !visible(video) || video.paused || videoKey(video) !== key) return;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        for (let j = 0; j < Math.min(result?.length || 0, 5); j++) {
          if (AdDetector.hasBrand(result[j]?.transcript) && skipSpoken(video, key).ok) return;
        }
      }
    };
    recognition.onerror = event => {
      if (event.error === 'not-allowed' || event.error === 'language-not-supported') {
        speechMode = null;
        stopSpeech();
      }
      if (event.error === 'network') speechRetryAt = Date.now() + 5000;
    };
    recognition.onend = () => {
      if (speechSession === session) {
        speechSession = null;
        track.stop();
        speechRetryAt = Date.now() + 400;
      }
    };
    try { recognition.start(track); } catch (_) {
      stopSpeech();
      speechRetryAt = Date.now() + 3000;
    }
  }

  function visible(video) {
    const box = video.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.top < innerHeight * 0.75 && box.bottom > innerHeight * 0.25;
  }

  function videoKey(video, card = findCard(video)) {
    return `${globalThis.location?.pathname || ''}|${video.currentSrc || video.src || card?.querySelector('a[href*="/video/"]')?.href || ''}`;
  }

  function findCard(video) {
    const known = video.closest('article, [data-e2e="recommend-list-item-container"], [data-e2e="feed-video"]');
    if (known) return known;
    let parent = video.parentElement;
    let card = parent;
    for (let i = 0; parent && i < 6; i++, parent = parent.parentElement) {
      if (parent.querySelectorAll('video').length > 1) break;
      card = parent;
    }
    return card;
  }

  function captionText(video) {
    const cues = [];
    for (const track of video.textTracks || []) {
      for (const cue of track.activeCues || []) cues.push(cue.text || '');
    }
    const box = video.getBoundingClientRect();
    const candidates = document.querySelectorAll('[data-e2e*="caption" i], [class*="caption" i], [class*="subtitle" i]');
    for (const element of candidates) {
      if (element.children.length) continue;
      const area = element.getBoundingClientRect();
      if (area.width > 0 && area.height > 0 && area.right > box.left && area.left < box.right && area.bottom > box.top && area.top < box.bottom) {
        cues.push(element.textContent || '');
      }
    }
    return cues.join(' ');
  }

  function hasAdLabel(card) {
    return [...card.querySelectorAll('span, a, div')].some(element =>
      element.children.length === 0 && AdDetector.isAdLabel(element.textContent)
    );
  }

  function skipVideo(video, key) {
    if (processed.get(video) === key) return false;
    if (!AdDetector.seekFourSeconds(video)) return false;
    processed.set(video, key);
    stopSpeech();
    stopFingerprint();
    return true;
  }

  function showError(error) {
    document.querySelector('#ad-skipper-error')?.remove();
    const notice = document.createElement('div');
    notice.id = 'ad-skipper-error';
    notice.textContent = `Пропуск рекламы: ${error}`;
    notice.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;max-width:420px;padding:12px 16px;border-radius:8px;background:#991b1b;color:#fff;font:14px Arial;box-shadow:0 4px 16px #0008';
    document.documentElement.append(notice);
    setTimeout(() => notice.remove(), 12000);
  }

  function tick() {
    let activeVideo = null;
    for (const video of document.querySelectorAll('video')) {
      if (!visible(video) || video.paused) continue;
      activeVideo = video;
      const card = findCard(video);
      if (!card) continue;
      const key = videoKey(video, card);
      listenForFingerprint(video, key);
      if (processed.get(video) === key) {
        listenToVideo(video, key);
        continue;
      }
      const text = `${(card.innerText || '').slice(0, 1800)} ${captionText(video)}`;
      if (hasAdLabel(card) || AdDetector.hasBrand(text)) {
        skipVideo(video, key);
      } else {
        listenToVideo(video, key);
      }
    }
    if (speechSession && speechSession.video !== activeVideo) stopSpeech();
    if (fingerprintSession && fingerprintSession.video !== activeVideo) stopFingerprint();
  }

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type === 'speech-context') {
      const active = [...document.querySelectorAll('video')].find(item => visible(item) && !item.paused);
      reply(active ? { key: videoKey(active), time: active.currentTime } : null);
      return;
    }
    if (message?.type === 'speech-status' && message.error) {
      showError(message.error);
      return;
    }
    if (message?.type !== 'speech-brand') return;
    const video = [...document.querySelectorAll('video')].find(item => visible(item) && !item.paused);
    if (!video) {
      reply({ ok: false, reason: 'нет активного видео' });
      return;
    }
    const card = findCard(video);
    const key = videoKey(video, card);
    if (message.context && (message.context.key !== key ||
      !Number.isFinite(message.context.time) || video.currentTime - message.context.time > 7 ||
      video.currentTime < message.context.time - 1)) {
      reply({ ok: false, stale: true, reason: 'фраза относилась к предыдущему видео или распознана слишком поздно' });
      return;
    }
    const before = video.currentTime;
    const result = skipSpoken(video, key);
    reply({ ...result, before, after: video.currentTime });
  });

  setInterval(tick, 300);
})();
