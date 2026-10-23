const API = 'https://sponsor.ajay.app/api/skipSegments';
const supportedVideoTab = url => /^https:\/\/(?:www\.tiktok\.com|(?:www|m)\.youtube\.com)\//.test(url || '');
const contentFiles = url => /youtube\.com\//.test(url || '') ? ['detector.js', 'youtube.js'] : ['detector.js', 'tiktok.js'];
chrome.action.setPopup?.({ popup: '' }).catch(() => {});

async function setBadge(tabId, text, color = '#16a34a', reason = '') {
  await chrome.action.setBadgeText({ tabId, text });
  if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setTitle({
    tabId,
    title: reason || (text === 'ON' ? 'Локальное распознавание речи TikTok включено. Нажмите, чтобы выключить.' :
      text === 'CLD' ? 'Облачное распознавание речи TikTok включено. Звук может передаваться сервису Chrome/Google. Нажмите, чтобы выключить.' :
      text === 'ERR' ? `Распознавание не запустилось: ${reason || 'неизвестная ошибка'}` :
      'Нажмите во вкладке TikTok или YouTube, чтобы включить распознавание речи.')
  });
}

async function showError(tabId, error) {
  const reason = String(error).slice(0, 220);
  await setBadge(tabId, 'ERR', '#dc2626', reason);
  chrome.tabs.sendMessage(tabId, { type: 'speech-status', error: reason }).catch(() => {});
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!contexts.length) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['USER_MEDIA'],
      justification: 'Распознавать рекламные фразы в звуке вкладки TikTok или YouTube'
    });
  }
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (firstError) {
    // Chrome invalidates content scripts when an unpacked extension is reloaded.
    const tab = await chrome.tabs.get(tabId);
    await chrome.scripting.executeScript({ target: { tabId }, files: contentFiles(tab.url) });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

chrome.action.onClicked.addListener(async tab => {
  if (!tab.id || !supportedVideoTab(tab.url)) return;
  const captured = await chrome.tabCapture.getCapturedTabs();
  const active = captured.find(item => item.status === 'active' || item.status === 'pending');
  if (active?.tabId === tab.id) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
    await setBadge(tab.id, '');
    return;
  }
  try {
    if (active) {
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
      await setBadge(active.tabId, '');
    }
    await ensureOffscreen();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const settings = await chrome.storage.local.get('allowCloudSpeech');
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen', type: 'start', streamId, tabId: tab.id,
      allowCloud: settings.allowCloudSpeech === true
    });
    if (!response?.ok) throw new Error(response?.error || 'Не удалось начать распознавание');
    await setBadge(tab.id, response.mode === 'cloud' ? 'CLD' : 'ON');
  } catch (error) {
    await showError(tab.id, error);
    console.error('Ad skipper speech:', error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === 'disable-cloud-speech') {
    (async () => {
      const captured = await chrome.tabCapture.getCapturedTabs();
      if (captured.length) await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
      await Promise.all(captured.map(item => setBadge(item.tabId, '')));
      reply({ ok: true });
    })().catch(error => reply({ ok: false, error: String(error) }));
    return true;
  }
  const fromOffscreen = _sender.url === chrome.runtime.getURL('offscreen.html');
  if (message?.type === 'speech-context-request' && fromOffscreen) {
    sendToTab(message.tabId, { type: 'speech-context' })
      .then(context => reply(context || null))
      .catch(() => reply(null));
    return true;
  }
  if (message?.type === 'speech-brand' && fromOffscreen) {
    sendToTab(message.tabId, { type: 'speech-brand', context: message.context })
      .then(result => setBadge(message.tabId, result?.ok ? 'SKIP' : result?.stale ? 'OLD' : 'NO',
        result?.ok ? '#16a34a' : '#d97706',
        result?.ok ? 'Реклама распознана: переход на 4 секунды выполнен.' : `Реклама распознана, но переход не выполнен: ${result?.reason || 'нет ответа от страницы'}`))
      .catch(error => setBadge(message.tabId, 'NO', '#d97706', `Реклама распознана, но вкладка не ответила: ${error}`));
    return;
  }
  if (message?.type === 'speech-diagnostic' && fromOffscreen) {
    const title = message.state === 'audio' ? 'Звук вкладки поступает. Ждём распознанные слова.' :
      message.state === 'transcript' ? `Распознано: ${message.transcript || ''}` :
      message.state === 'stale' ? 'Фраза распознана, но видео уже сменилось; новое видео не перематывалось.' :
      'Распознавание запущено. Ждём звук вкладки.';
    const badge = message.state === 'transcript' ? 'TXT' : message.state === 'audio' ? 'AUD' : message.state === 'stale' ? 'OLD' : 'CLD';
    setBadge(message.tabId, badge, '#2563eb', title).catch(() => {});
    return;
  }
  if (message?.type === 'speech-error' && fromOffscreen) {
    showError(message.tabId, message.error).catch(() => {});
    return;
  }
  if (message?.type === 'speech-stopped' && fromOffscreen) {
    setBadge(message.tabId, '').catch(() => {});
    return;
  }
  if (message?.type !== 'segments' || !/^[A-Za-z0-9_-]{11}$/.test(message.videoId || '')) return;
  const url = `${API}?videoID=${encodeURIComponent(message.videoId)}&categories=${encodeURIComponent(JSON.stringify(['sponsor', 'selfpromo']))}`;
  fetch(url, { signal: AbortSignal.timeout(8000) })
    .then(async response => {
      if (response.status === 404) return [];
      if (!response.ok) throw new Error(`SponsorBlock: ${response.status}`);
      return response.json();
    })
    .then(data => reply({ segments: Array.isArray(data) ? data.map(x => x.segment).filter(x => Array.isArray(x) && x.length === 2 && x.every(Number.isFinite) && x[1] > x[0]) : [] }))
    .catch(error => reply({ error: String(error) }));
  return true;
});
