import { defaultConfig } from "./core/config.js";

const K = {
  config: "pm.config.v1",
  bias: "pm.bias.v1",
  sign: "pm.gravitySign.v1",
  zones: "pm.zones.v1",
  logs: "pm.logs.v1",
};

function read(key, fallback) {
  try {
    const s = localStorage.getItem(key);
    return s == null ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
}

/** 용량 초과면 false. 원시 데이터가 쌓이면 localStorage(보통 5 MB)를 넘길 수 있다 */
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// 저장된 설정을 기본값 위에 덮어쓴다. 버전이 올라가며 새로 생긴 키는 기본값을 받게 하려고.
export const loadConfig = () => ({ ...defaultConfig(), ...read(K.config, {}) });
export const saveConfig = (c) => write(K.config, c);
export const resetConfig = () => localStorage.removeItem(K.config);

export const loadBias = () => read(K.bias, null);
export const saveBias = (b) => write(K.bias, b);

export const loadSign = () => read(K.sign, null);
export const saveSign = (s) => write(K.sign, s);

export const loadZones = () => read(K.zones, []);
export const saveZones = (z) => write(K.zones, z);

export const loadLogs = () => read(K.logs, []);
export const saveLogs = (l) => write(K.logs, l);

export function clearCalibration() {
  localStorage.removeItem(K.bias);
  localStorage.removeItem(K.sign);
}
