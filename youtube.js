(() => {
  let videoId = null;
  let video = null;
  let segments = [];
  let requestId = 0;
  let lastSkip = -1;
  let lastCaption = '';
  let lastCaptionSkipAt = 0;

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
      if (id && video) load(id);
    }
    if (!id || !video || video.paused || !Number.isFinite(video.duration) || document.querySelector('.ad-showing')) return;
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

  setInterval(tick, 350);
})();
