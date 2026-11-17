/**
 * watchPosition 수집기. 페이지가 열려 있는 동안 계속 켜 두면 다음 측정 때 GPS가 이미 수렴해 있다.
 */
export class LocationSensor {
  constructor({ keepSeconds = 180 } = {}) {
    this.keep = keepSeconds;
    this.fixes = [];
    this.watchId = null;
    this.lastError = null;
    this.listeners = new Set();
  }

  static supported() {
    return typeof navigator !== "undefined" && "geolocation" in navigator;
  }

  get running() {
    return this.watchId != null;
  }

  start() {
    if (this.watchId != null || !LocationSensor.supported()) return;
    this.watchId = navigator.geolocation.watchPosition(
      (p) => {
        // 판정의 시간 기준을 Date.now()로 통일하려고 수신 시각을 t로 쓴다.
        // position.timestamp는 브라우저에 따라 캐시된 위치의 시각일 수 있어서 따로 남겨만 둔다.
        const now = Date.now();
        const fix = {
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          accuracy: p.coords.accuracy,
          t: now,
          posTimestamp: p.timestamp,
        };
        this.fixes.push(fix);
        this.fixes = this.fixes.filter((f) => now - f.t <= this.keep * 1000);
        this.lastError = null;
        this.listeners.forEach((cb) => cb(fix));
      },
      (err) => {
        this.lastError = err;
        this.listeners.forEach((cb) => cb(null, err));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
  }

  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  recent(windowSec, now = Date.now()) {
    return this.fixes.filter((f) => (now - f.t) / 1000 <= windowSec);
  }

  latest() {
    return this.fixes[this.fixes.length - 1] ?? null;
  }

  onUpdate(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

export function geoErrorText(err) {
  if (!err) return "";
  return { 1: "위치 권한이 거부됐습니다.", 2: "위치를 확인할 수 없습니다.", 3: "위치 응답 시간 초과" }[err.code] ?? err.message;
}
