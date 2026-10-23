(() => {
  const brands = /\b(?:upgrader|float[\s-]*up|musor[\s-]*drop)\b|апгрейдер|фл[оа]т[\s-]*(?:ап|уп)|флоу[\s-]*(?:ап|уп)|мусор[\s-]*дроп/iu;
  const otherBrands = /\b(?:gg[\s-]*drop|force[\s-]*drop|skin[\s.]*club|hell[\s-]*case|key[\s-]*drop)\b|джи[\s-]*джи[\s-]*дроп|форс[\s-]*дроп|скин[\s-]*клаб|хелл[\s-]*кейс|кей[\s-]*дроп/iu;
  const floatUpPhrase = /(?:заходи(?:те)?|переходи(?:те)?)[\s\S]{0,65}?(?:ап[\s-]*ап|уп[\s-]*уп|up[\s-]*up)/iu;
  const musorDropPhrase = /(?:твой|ваш|самый)[\s\S]{0,18}?высокий шанс(?:[\s\S]{0,18}?(?:дроп|дроб|троп|drop))?/iu;
  const adLabel = /^(?:реклама|sponsored|promoted|paid partnership|платное партн[её]рство)$/iu;

  globalThis.AdDetector = Object.freeze({
    hasBrand(text) {
      const value = String(text || '');
      return brands.test(value) || otherBrands.test(value) || floatUpPhrase.test(value) || musorDropPhrase.test(value);
    },
    isAdLabel(text) {
      return adLabel.test(String(text || '').trim());
    },
    seekFourSeconds(video) {
      if (!video || !Number.isFinite(video.currentTime) || !Number.isFinite(video.duration)) return false;
      const target = Math.min(video.currentTime + 4, Math.max(0, video.duration - 0.1));
      if (target <= video.currentTime + 0.2) return false;
      video.currentTime = target;
      return true;
    }
  });
})();
