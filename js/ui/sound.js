/**
 * 결과 알림음. 휴대폰이 데크 위(발밑)에 있어서 화면을 안 보고도 결과를 알 수 있게 한다.
 * iOS는 사용자 탭 안에서 AudioContext를 깨워야 소리가 나서 unlock()을 측정 버튼 핸들러에서 부른다.
 */
let ac = null;

export function unlockAudio() {
  try {
    ac ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === "suspended") ac.resume();
  } catch {
    ac = null;
  }
}

function tone(freq, start, dur) {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = "sine";
  o.frequency.value = freq;
  // 딸깍 소리가 나지 않게 짧게 올렸다 내린다
  g.gain.setValueAtTime(0, ac.currentTime + start);
  g.gain.linearRampToValueAtTime(0.25, ac.currentTime + start + 0.02);
  g.gain.linearRampToValueAtTime(0, ac.currentTime + start + dur);
  o.connect(g).connect(ac.destination);
  o.start(ac.currentTime + start);
  o.stop(ac.currentTime + start + dur + 0.02);
}

// 올라가면 통과, 한 번이면 확인 필요, 내려가면 다시 세우기. 음 높이 방향만으로 구분되게 했다
const PATTERNS = {
  returnWithoutPhoto: { tones: [[660, 0, 0.14], [880, 0.16, 0.2]], vibrate: [60] },
  requirePhoto: { tones: [[560, 0, 0.3]], vibrate: [60, 80, 60] },
  reject: { tones: [[392, 0, 0.18], [262, 0.2, 0.3]], vibrate: [200, 80, 200] },
};

export function playResult(decision) {
  const p = PATTERNS[decision];
  if (!p) return;
  // iOS Safari는 진동을 지원하지 않는다. Android만 울린다
  try { navigator.vibrate?.(p.vibrate); } catch { /* 무시 */ }
  if (!ac) return;
  try {
    p.tones.forEach(([f, s, d]) => tone(f, s, d));
  } catch { /* 소리 실패는 판정과 무관 */ }
}
