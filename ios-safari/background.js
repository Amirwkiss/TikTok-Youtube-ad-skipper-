browser.runtime.onMessage.addListener(async message => {
  if (message?.type !== 'segments' || !/^[A-Za-z0-9_-]{11}$/.test(message.videoId || '')) return null;
  const url = `https://sponsor.ajay.app/api/skipSegments?videoID=${encodeURIComponent(message.videoId)}&categories=${encodeURIComponent(JSON.stringify(['sponsor', 'selfpromo']))}`;
  try {
    const response = await fetch(url);
    if (response.status === 404) return [];
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data) ? data.map(item => item.segment).filter(item =>
      Array.isArray(item) && item.length === 2 && item.every(Number.isFinite) && item[1] > item[0]) : [];
  } catch (_) {
    return [];
  }
});
