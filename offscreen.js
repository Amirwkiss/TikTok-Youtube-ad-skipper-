(() => {
  let media = null;
  let audioContext = null;
  let recognition = null;
  let tabId = null;
  let restartTimer = null;
  let meterTimer = null;
  let heardAudio = false;
  let lastBrandAt = 0;
  let fingerprintMatcher = null;

  function emitBrand(context) {
    if (Date.now() - lastBrandAt < 8000) return;
    lastBrandAt = Date.now();
    if (context?.key && Number.isFinite(context.time)) {
      chrome.runtime.sendMessage({ type: 'speech-brand', tabId, context });
    } else {
      report('stale');
    }
  }

  function report(state, transcript = '') {
    if (tabId) chrome.runtime.sendMessage({ type: 'speech-diagnostic', tabId, state, transcript });
  }

  async function stop() {
    clearTimeout(restartTimer);
    clearInterval(meterTimer);
    meterTimer = null;
    heardAudio = false;
    lastBrandAt = 0;
    fingerprintMatcher?.stop();
    fingerprintMatcher = null;
    const oldRecognition = recognition;
    recognition = null;
    if (oldRecognition) {
      oldRecognition.onend = null;
      oldRecognition.onerror = null;
      try { oldRecognition.abort(); } catch (_) {}
    }
    media?.getTracks().forEach(track => track.stop());
    media = null;
    tabId = null;
    if (audioContext) await audioContext.close();
    audioContext = null;
  }

  function listen(track, useCloud) {
    if (!media || !tabId || track.readyState !== 'live') return;
    const Speech = globalThis.SpeechRecognition;
    const current = new Speech();
    current.lang = 'ru-RU';
    current.processLocally = !useCloud;
    current.continuous = true;
    current.interimResults = true;
    current.maxAlternatives = 5;
    recognition = current;
    let contextPromise = null;
    const captureContext = () => {
      contextPromise = chrome.runtime.sendMessage({ type: 'speech-context-request', tabId })
        .catch(() => null);
    };
    current.onsoundstart = captureContext;
    current.onspeechstart = () => { if (!contextPromise) captureContext(); };
    current.onresult = async event => {
      const recognitionContext = contextPromise;
      const recent = [];
      let matched = false;
      for (let i = Math.max(0, event.results.length - 5); i < event.results.length; i++) {
        const result = event.results[i];
        const best = result?.[0]?.transcript || '';
        if (best) recent.push(best);
        if (i >= event.resultIndex && best) report('transcript', best.slice(0, 160));
        for (let j = 0; j < Math.min(result?.length || 0, 5); j++) {
          if (AdDetector.hasBrand(result[j]?.transcript)) {
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      if (matched || AdDetector.hasBrand(recent.join(' ').slice(-220))) {
        emitBrand(await (recognitionContext || Promise.resolve(null)));
      }
    };
    current.onerror = event => {
      if (event.error === 'not-allowed' || event.error === 'language-not-supported' || event.error === 'network') {
        chrome.runtime.sendMessage({ type: 'speech-error', tabId, error: event.error });
        stop();
      }
    };
    current.onend = () => {
      if (recognition !== current || !media) return;
      recognition = null;
      restartTimer = setTimeout(() => listen(track, useCloud), 500);
    };
    try { current.start(track); } catch (_) {
      recognition = null;
      restartTimer = setTimeout(() => listen(track, useCloud), 3000);
    }
  }

  async function start(message) {
    await stop();
    const Speech = globalThis.SpeechRecognition;
    media = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } },
      video: false
    });
    tabId = message.tabId;
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(media);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    analyser.connect(audioContext.destination);
    const samples = new Float32Array(analyser.fftSize);
    meterTimer = setInterval(() => {
      if (!tabId || heardAudio) return;
      analyser.getFloatTimeDomainData(samples);
      const level = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
      if (level > 0.003) {
        heardAudio = true;
        report('audio');
      }
    }, 500);
    const track = media.getAudioTracks()[0];
    if (!track) throw new Error('Вкладка не передаёт звук');
    track.onended = () => { chrome.runtime.sendMessage({ type: 'speech-stopped', tabId }); stop(); };
    fingerprintMatcher = globalThis.AdAudioFingerprint?.listen(media, async result => {
      const context = await chrome.runtime.sendMessage({ type: 'speech-context-request', tabId }).catch(() => null);
      report('transcript', `звук: ${result.name} (${result.score.toFixed(2)}, ${result.elapsedMs.toFixed(0)} мс)`);
      emitBrand(context);
    }) || null;
    if (!Speech?.available || !('processLocally' in Speech.prototype)) {
      if (fingerprintMatcher) return 'fingerprint';
      throw new Error('Локальное распознавание речи недоступно');
    }
    let status = 'unavailable';
    try {
      status = await Speech.available({ langs: ['ru-RU'], processLocally: true });
      if (status === 'downloadable' && Speech.install) {
        const installed = await Speech.install({ langs: ['ru-RU'] });
        status = installed ? 'available' : 'unavailable';
      }
    } catch (_) {}
    const useCloud = status !== 'available';
    if (useCloud && !message.allowCloud) {
      if (fingerprintMatcher) return 'fingerprint';
      throw new Error('Русский языковой пакет недоступен');
    }
    listen(track, useCloud);
    return useCloud ? 'cloud' : 'local';
  }

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.target !== 'offscreen') return;
    if (message.type === 'stop') {
      stop().then(() => reply({ ok: true }));
      return true;
    }
    if (message.type === 'start') {
      start(message).then(mode => reply({ ok: true, mode })).catch(async error => {
        await stop();
        reply({ ok: false, error: String(error) });
      });
      return true;
    }
  });
})();
