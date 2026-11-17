import { G0, deg2rad } from "../core/math.js";

/**
 * devicemotion 수집기.
 * 버퍼에는 브라우저 원시값을 그대로 넣고, 판정용 샘플(아래 방향 중력, g 단위)은 부호를 정한 뒤에 만든다.
 * 원시값을 남겨두는 이유: 부호 규약이 기기·브라우저마다 달라서 나중에 다시 해석할 수 있어야 한다.
 */
export class MotionSensor {
  constructor({ keepSeconds = 20 } = {}) {
    this.keep = keepSeconds;
    this.buf = [];
    this.running = false;
    this.rateHz = 0;
    this.gyroAvailable = null;
    this._lastT = null;
    this._handler = (e) => this._onMotion(e);
  }

  static supported() {
    return typeof window !== "undefined" && "DeviceMotionEvent" in window;
  }

  static needsPermission() {
    return typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function";
  }

  /** iOS는 탭 같은 사용자 동작 안에서, 다른 await보다 먼저 불러야 권한 창이 뜬다 */
  static async requestPermission() {
    if (!MotionSensor.needsPermission()) return "granted";
    try {
      return await DeviceMotionEvent.requestPermission();
    } catch {
      return "denied";
    }
  }

  start() {
    if (this.running) return;
    this.buf = [];
    this._lastT = null;
    window.addEventListener("devicemotion", this._handler);
    this.running = true;
  }

  stop() {
    window.removeEventListener("devicemotion", this._handler);
    this.running = false;
  }

  clear() {
    this.buf = [];
  }

  _onMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    const t = (e.timeStamp || performance.now()) / 1000;

    if (this._lastT != null) {
      const dt = t - this._lastT;
      if (dt > 0 && dt < 1) this.rateHz = this.rateHz ? 0.95 * this.rateHz + 0.05 / dt : 1 / dt;
    }
    this._lastT = t;

    // 명세상 rotationRate는 deg/s. 축 대응(alpha=z, beta=x, gamma=y)은 크기만 쓰니 상관없지만 맞춰 둔다
    const rr = e.rotationRate;
    const hasGyro = rr != null && rr.alpha != null;
    this.gyroAvailable = hasGyro;
    const rot = hasGyro
      ? { x: deg2rad(rr.beta ?? 0), y: deg2rad(rr.gamma ?? 0), z: deg2rad(rr.alpha ?? 0) }
      : { x: 0, y: 0, z: 0 };

    // 중력 뺀 가속도가 없는 기기는 |a| − 1g로 근사한다. 기울기가 바뀌는 움직임은 못 잡지만 진동은 잡힌다
    const lin = e.acceleration;
    const userAccel = lin && lin.x != null
      ? Math.hypot(lin.x, lin.y, lin.z) / G0
      : Math.abs(Math.hypot(a.x, a.y, a.z) - G0) / G0;

    this.buf.push({ t, ax: a.x, ay: a.y, az: a.z, rotationRate: rot, userAccel });
    // 앞에서부터 오래된 것만 잘라낸다
    let i = 0;
    while (i < this.buf.length && t - this.buf[i].t > this.keep) i++;
    if (i) this.buf.splice(0, i);
  }

  /** 시각 since(초, 이벤트 시간축) 이후 원시 샘플 */
  rawSince(since = -Infinity) {
    return this.buf.filter((s) => s.t >= since);
  }

  lastT() {
    return this.buf.length ? this.buf[this.buf.length - 1].t : null;
  }
}

/**
 * 원시 샘플 → 판정용 샘플.
 * sign: g_down = sign · a / G0. 명세 규약(화면 위 z=+9.8)이면 -1, 반대 규약이면 +1.
 */
export function toJudgeSamples(raw, sign) {
  return raw.map((s) => ({
    t: s.t,
    gravity: { x: (sign * s.ax) / G0, y: (sign * s.ay) / G0, z: (sign * s.az) / G0 },
    rotationRate: s.rotationRate,
    userAccel: s.userAccel,
  }));
}

/** 화면이 위라고 가정하고 부호를 고른다: 아래 방향 중력의 z가 음수가 되게 */
export function inferSignFaceUp(raw) {
  if (!raw.length) return -1;
  const z = raw.reduce((acc, s) => acc + s.az, 0) / raw.length;
  return z < 0 ? 1 : -1;
}
