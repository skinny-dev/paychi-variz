// Picks the design system before first paint: Material 3 everywhere, iOS look on Apple touch devices.
// Preview either one on any device with ?platform=ios, ?platform=material, or ?platform=auto to reset.
(function () {
  var forced = null;
  try {
    var q = new URLSearchParams(location.search).get('platform');
    if (q === 'auto') localStorage.removeItem('platform');
    else if (q === 'ios' || q === 'material') localStorage.setItem('platform', q);
    forced = localStorage.getItem('platform');
  } catch (e) { /* storage unavailable: fall back to detection */ }
  var isIOS =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS reports as Mac
  document.documentElement.dataset.platform = forced || (isIOS ? 'ios' : 'material');
})();
