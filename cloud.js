const status = document.querySelector('#status');

async function save(allowed) {
  await chrome.storage.local.set({ allowCloudSpeech: allowed });
  await chrome.action.setPopup({ popup: '' });
  if (!allowed) await chrome.runtime.sendMessage({ type: 'disable-cloud-speech' });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
  status.textContent = allowed
    ? 'Разрешено. Перезагрузите вкладку TikTok. Распознавание запустится само, если браузер отдаёт звук видео; значок расширения включает запасной захват звука вкладки.'
    : 'Облачное распознавание выключено. Поиск по тексту и субтитрам продолжит работать.';
}

document.querySelector('#allow').addEventListener('click', () => save(true));
document.querySelector('#deny').addEventListener('click', () => save(false));
chrome.storage.local.get('allowCloudSpeech').then(value => {
  if (value.allowCloudSpeech) status.textContent = 'Облачное распознавание сейчас разрешено. Нажмите «Только текст и субтитры», чтобы отозвать разрешение.';
});
