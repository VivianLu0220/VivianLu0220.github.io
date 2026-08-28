/* Shared behaviour for inner pages: language toggle, noise background, hover-focus rows.
   Expects mind-noise.js to be loaded first. Body may carry data-noise-mode="traffic|instrument|swarm"
   and data-noise-chaos="0.4". */
(function () {
  const apply = (lang) => {
    document.documentElement.classList.toggle('lang-en', lang === 'en');
    document.querySelectorAll('[data-lang-btn]').forEach((b) => {
      const on = b.dataset.langBtn === lang;
      b.style.color = on ? 'oklch(0.92 0.15 var(--em-h))' : '#75726e';
      b.style.background = on ? 'oklch(0.6 0.12 var(--em-h) / 0.16)' : 'none';
    });
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    try { localStorage.setItem('nd-lang', lang); } catch (e) {}
    document.dispatchEvent(new CustomEvent('langchange', { detail: lang }));
  };
  document.querySelectorAll('[data-lang-btn]').forEach((b) =>
    b.addEventListener('click', () => apply(b.dataset.langBtn)));
  let saved = 'zh';
  try { saved = localStorage.getItem('nd-lang') || 'zh'; } catch (e) {}
  apply(saved);
  window.siteLang = () => (document.documentElement.classList.contains('lang-en') ? 'en' : 'zh');

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const b = document.body.dataset;
  if (window.MindNoise) window.MindNoise.init({
    mode: b.noiseMode || 'traffic',
    chaos: reduced ? 0.2 : parseFloat(b.noiseChaos || '0.5'),
    moodPeriod: 46,
    glitch: !reduced,
    dropouts: !reduced && b.noiseDropouts !== 'off',
  });
})();
