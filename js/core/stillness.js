import { norm3 } from "./math.js";

/**
 * samples: [{t[s], gravity{x,y,z}[g, 아래 방향], rotationRate{x,y,z}[rad/s], userAccel[g 크기]}]
 * 버퍼 끝에서 거슬러 올라가며 연속으로 조용한 구간을 돌려준다.
 * 끝 구간만 보는 이유: 손을 뗀 뒤의 상태만 의미가 있고, 그 전 움직임은 당연히 있기 때문이다.
 * 움직이는 동안의 가속도에는 운동가속도가 섞여 기울기가 틀어진다.
 */
export function trailingStillWindow(samples, gyroThreshold, accelThreshold) {
  let start = samples.length;
  while (start > 0) {
    const s = samples[start - 1];
    if (norm3(s.rotationRate) < gyroThreshold && s.userAccel < accelThreshold) start--;
    else break;
  }
  return samples.slice(start);
}

export function windowDuration(w) {
  return w.length ? w[w.length - 1].t - w[0].t : 0;
}

export function meanGravity(w) {
  if (!w.length) return null;
  const acc = { x: 0, y: 0, z: 0 };
  for (const s of w) {
    acc.x += s.gravity.x;
    acc.y += s.gravity.y;
    acc.z += s.gravity.z;
  }
  return { x: acc.x / w.length, y: acc.y / w.length, z: acc.z / w.length };
}
