export const G0 = 9.80665;

export const deg2rad = (d) => (d * Math.PI) / 180;
export const rad2deg = (r) => (r * 180) / Math.PI;

export const norm3 = (v) => Math.hypot(v.x, v.y, v.z);

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
