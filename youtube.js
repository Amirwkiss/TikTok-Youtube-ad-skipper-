(() => {
  let videoId = null;
  let video = null;
  let segments = [];
  let requestId = 0;
  let lastSkip = -1;
  let lastCaption = '';
  let lastCaptionSkipAt = 0;
  const Speech = globalThis.SpeechRecognition;
  let speechMode = null;
  let speechSession = null;
  let speechRetryAt = 0;
  let lastSpokenSkipAt = 0;
  let fingerprintSession = null;

  if (Speech?.available && 'processLocally' in Speech.prototype) {
    Speech.available({ langs: ['ru-RU'], processLocally: true }).then(async status => {
      if (status === 'available' || (status === 'downloadable' && Speech.install &&
        await Speech.install({ langs: ['ru-RU'] }))) speechMode = 'local';
    }).catch(() => {});
  }
  chrome.storage?.local?.get('allowCloudSpeech')?.then(settings => {
    if (settings.allowCloudSpeech === true && !speechMode && Speech) speechMode = 'cloud';
  }).catch(() => {});
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes.allowCloudSpeech) return;
    if (changes.allowCloudSpeech.newValue === true && !speechMode && Speech) speechMode = 'cloud';
    if (changes.allowCloudSpeech.newValue !== true && speechMode === 'cloud') {
      speechMode = null;
      stopSpeech();
    }
  });

  function stopSpeech() {
    const old = speechSession;
    speechSession = null;
    if (!old) return;
    old.recognition.onend = null;
    old.recognition.onresult = null;
    old.recognition.onerror = null;
    try { old.recognition.abort(); } catch (_) {}
    old.track.stop();
  }

  function stopFingerprint() {
    const old = fingerprintSession;
    fingerprintSession = null;
    old?.matcher.stop();
    old?.track.stop();
  }

  function activeKey() {
    return `${currentId() || ''}|${video?.currentSrc || video?.src || ''}`;
  }

  function skipSpoken() {
    if (!video || video.paused || document.querySelector('.ad-showing')) return { ok: false, reason: 'нет активного видео' };
    if (Date.now() - lastSpokenSkipAt < 2500) return { ok: false, reason: 'недавний переход' };
    if (!AdDetector.seekFourSeconds(video)) return { ok: false, reason: 'перемотка недоступна' };
    lastSpokenSkipAt = Date.now();
    stopSpeech();
    stopFingerprint();
    return { ok: true };
  }

  function listenForFingerprint() {
    if (!globalThis.AdAudioFingerprint || !video || typeof video.captureStream !== 'function') return;
    const key = activeKey();
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
      if (fingerprintSession !== session || activeKey() !== key || video.paused) return;
      if (skipSpoken().ok) console.debug('Ad skipper audio match', result.name, result.score, result.elapsedMs);
    });
    fingerprintSession = session;
  }

  function listenToVideo() {
    if (!speechMode || !video || typeof video.captureStream !== 'function' || Date.now() < speechRetryAt) return;
    const key = activeKey();
    if (speechSession?.video === video && speechSession.key === key) return;
    stopSpeech();
    let track;
    try { track = video.captureStream().getAudioTracks().find(item => item.readyState === 'live'); }
    catch (_) { return; }
    if (!track) return;
    const recognition = new Speech();
    recognition.lang = 'ru-RU';
    recognition.processLocally = speechMode === 'local';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;
    const session = { video, key, track, recognition };
    speechSession = session;
    recognition.onresult = event => {
      if (speechSession !== session || activeKey() !== key || video.paused) return;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        for (let j = 0; j < Math.min(result?.length || 0, 5); j++) {
          if (AdDetector.hasBrand(result[j]?.transcript) && skipSpoken().ok) return;
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

  function currentId() {
    const url = new URL(location.href);
    if (url.pathname === '/watch') return url.searchParams.get('v');
    return url.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/)?.[1] || null;
  }

  function validSegment(segment) {
    return Array.isArray(segment) && segment.length === 2 &&
      segment.every(Number.isFinite) && segment[0] >= 0 && segment[1] > segment[0];
  }

  function load(id) {
    const currentRequest = ++requestId;
    segments = [];
    chrome.runtime.sendMessage({ type: 'segments', videoId: id }, response => {
      if (currentRequest !== requestId) return;
      segments = (response?.segments || []).filter(validSegment).sort((a, b) => a[0] - b[0]);
    });
  }

  function tick() {
    const id = currentId();
    const activeVideo = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (id !== videoId || activeVideo !== video) {
      videoId = id;
      video = activeVideo;
      lastSkip = -1;
      lastCaption = '';
      lastCaptionSkipAt = 0;
      segments = [];
      stopSpeech();
      stopFingerprint();
      if (id && video) load(id);
    }
    if (!id || !video || video.paused || !Number.isFinite(video.duration) || document.querySelector('.ad-showing')) return;
    listenToVideo();
    listenForFingerprint();
    const segment = segments.find(([start, end]) => video.currentTime >= start && video.currentTime < end - 0.15);
    if (segment && lastSkip !== segment[1]) {
      video.currentTime = Math.min(segment[1], video.duration);
      lastSkip = segment[1];
      return;
    } else if (!segment) {
      lastSkip = -1;
    }

    const caption = [...document.querySelectorAll('.ytp-caption-segment')]
      .map(element => element.textContent || '').join(' ').trim();
    if (caption !== lastCaption) {
      lastCaption = caption;
      if (AdDetector.hasBrand(caption) && Date.now() - lastCaptionSkipAt >= 1200 && AdDetector.seekFourSeconds(video)) {
        lastCaptionSkipAt = Date.now();
      }
    }
  }

  chrome.runtime?.onMessage?.addListener((message, _sender, reply) => {
    if (message?.type === 'speech-context') {
      reply(video && !video.paused ? { key: activeKey(), time: video.currentTime } : null);
      return;
    }
    if (message?.type === 'speech-brand') {
      if (!video || video.paused || (message.context &&
        (message.context.key !== activeKey() ||
          !Number.isFinite(message.context.time) ||
          video.currentTime - message.context.time > 7 ||
          video.currentTime < message.context.time - 1))) {
        reply({ ok: false, stale: true, reason: 'видео сменилось или фраза распознана слишком поздно' });
        return;
      }
      reply(skipSpoken());
    }
  });

  setInterval(tick, 350);
})();
