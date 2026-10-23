(() => {
  const brand = /\b(?:upgrader|float[\s-]*up|musor[\s-]*drop|gg[\s-]*drop|force[\s-]*drop|skin[\s.]*club|hell[\s-]*case|key[\s-]*drop)\b|апгрейдер|фл(?:оа|о|а)т[\s-]*(?:ап|уп)|флоу[\s-]*(?:ап|уп)|мусор[\s-]*дроп|надоел[иы][\s\S]{0,25}?мусорн(?:ые|ых)\s+скин(?:ы|ов)|(?:заходи(?:те)?|переходи(?:те)?)[\s\S]{0,65}?(?:ап[\s-]*ап|уп[\s-]*уп|up[\s-]*up)/iu;
  const adLabel = /^(?:реклама|sponsored|promoted|paid partnership|платное партн[её]рство)$/iu;
  let key = '';
  let lastText = '';
  let lastSkippedKey = '';
  let segments = [];
  let request = 0;
  let activeRef = null;

  function seek(video, seconds = 4) {
    if (!Number.isFinite(video.currentTime) || !Number.isFinite(video.duration)) return false;
    const target = Math.min(video.currentTime + seconds, video.duration - 0.1);
    if (target <= video.currentTime + 0.2) return false;
    video.currentTime = target;
    return true;
  }

  function activeVideo() {
    const videos = [...document.querySelectorAll('video')].filter(video => !video.paused);
    return videos.find(video => {
      const box = video.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight;
    }) || null;
  }

  function textTracks(video) {
    const cues = [];
    for (const track of video.textTracks || []) {
      for (const cue of track.activeCues || []) cues.push(cue.text || '');
    }
    return cues.join(' ');
  }

  function tiktokCard(video) {
    return video.closest('article, [data-e2e="recommend-list-item-container"], [data-e2e="feed-video"]') || video.parentElement?.parentElement;
  }

  function tiktokText(video) {
    const card = tiktokCard(video);
    if (!card) return { text: textTracks(video), label: false };
    const label = [...card.querySelectorAll('span, a, div')].some(element =>
      element.children.length === 0 && adLabel.test((element.textContent || '').trim()));
    return { text: `${(card.innerText || '').slice(0, 1600)} ${textTracks(video)}`, label };
  }

  function youtubeId() {
    const url = new URL(location.href);
    return url.pathname === '/watch' ? url.searchParams.get('v') :
      url.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/)?.[1] || null;
  }

  function loadSegments(id) {
    const current = ++request;
    segments = [];
    if (!id) return;
    browser.runtime.sendMessage({ type: 'segments', videoId: id }).then(result => {
      if (current === request) segments = Array.isArray(result) ? result : [];
    }).catch(() => {});
  }

  function tick() {
    const video = activeVideo();
    if (!video) return;
    const youtube = /(^|\.)youtube\.com$/.test(location.hostname);
    const id = youtube ? youtubeId() : '';
    const nextKey = `${location.pathname}|${id || ''}|${video.currentSrc || video.src || ''}`;
    if (nextKey !== key || video !== activeRef) {
      key = nextKey;
      activeRef = video;
      lastText = '';
      lastSkippedKey = '';
      loadSegments(youtube ? id : null);
    }
    if (youtube && document.querySelector('.ad-showing')) return;
    if (youtube) {
      const segment = segments.find(([start, end]) => video.currentTime >= start && video.currentTime < end - 0.15);
      if (segment && lastSkippedKey !== `${key}|${segment[1]}`) {
        if (seek(video, segment[1] - video.currentTime)) lastSkippedKey = `${key}|${segment[1]}`;
        return;
      }
    }
    const details = youtube ? {
      text: `${textTracks(video)} ${[...document.querySelectorAll('.ytp-caption-segment')].map(item => item.textContent || '').join(' ')}`,
      label: false
    } : tiktokText(video);
    const { text, label } = details;
    if (text !== lastText) {
      lastText = text;
      if ((label || brand.test(text)) && (youtube || lastSkippedKey !== key)) {
        if (seek(video)) lastSkippedKey = key;
      }
    }
  }

  setInterval(tick, 300);
})();
