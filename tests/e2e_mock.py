"""헤드리스 Chrome으로 웹 실험 도구 전체 흐름을 모의 센서로 돌린다.
사용: python3 tests/e2e_mock.py <base_url> <screenshot_dir> <convention: spec|ios> [mode: handlebar|deck]
센서 부호 규약: spec = 화면 위일 때 z=+9.8(W3C 명세), ios = 반대 부호.
Chrome 경로는 CHROME 환경변수로 바꿀 수 있다.
"""
import json, os, sys, time, pathlib
from playwright.sync_api import sync_playwright

BASE, OUT, CONV = sys.argv[1], pathlib.Path(sys.argv[2]), sys.argv[3]
MODE = sys.argv[4] if len(sys.argv) > 4 else "handlebar"
OUT.mkdir(parents=True, exist_ok=True)
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
LAT0, LON0 = 37.45050, 126.65370
M_PER_DEG_LON = 111320 * 0.79386  # cos(37.45°)

MOCK = r"""
(() => {
  if (typeof DeviceMotionEvent === "undefined") return;  // about:blank 같은 비보안 문맥
  const G0 = 9.80665;
  const d2r = (d) => d * Math.PI / 180;
  // mount: 핸들 거치대. 화면이 타는 사람 쪽으로 mountTilt만큼 위로 들리고, 핸들과 mountKappa만큼 틀어져 꽂힘
  window.__mock = { roll: 0, pitch: 0, moving: false, sway: 0, swayHz: 0.8, conv: "%CONV%", lat: %LAT0%, lon: %LON0%, acc: 4.0,
                    mount: %MOUNT%, mountTilt: 35, mountKappa: 1.5 };
  setInterval(() => {
    const m = window.__mock;
    const ts = performance.now() / 1000;
    // sway: 손을 뗀 뒤에도 데크가 좌우로 계속 흔들리는 상황
    const swayRoll = m.sway * Math.sin(2 * Math.PI * m.swayHz * ts);
    const swayRate = m.sway ? m.sway * 2 * Math.PI * m.swayHz * Math.cos(2 * Math.PI * m.swayHz * ts) + 3 : 0;
    const r = d2r(m.roll + swayRoll), p = d2r(m.pitch);
    let gd = { x: -Math.sin(r) * Math.cos(p), y: Math.sin(p), z: -Math.cos(r) * Math.cos(p) };  // 차체 좌표의 아래 방향
    if (m.mount) {
      const a = d2r(m.mountTilt), k = d2r(m.mountKappa);
      const x = [1, 0, 0], y = [0, Math.sin(a), Math.cos(a)], z = [0, -Math.cos(a), Math.sin(a)];
      const xk = x.map((v, i) => v * Math.cos(k) + y[i] * Math.sin(k)), yk = x.map((v, i) => -v * Math.sin(k) + y[i] * Math.cos(k));
      const dd = [gd.x, gd.y, gd.z], dot = (q) => dd[0] * q[0] + dd[1] * q[1] + dd[2] * q[2];
      gd = { x: dot(xk), y: dot(yk), z: dot(z) };
    }
    const k = m.conv === "spec" ? -G0 : G0;
    const jit = m.moving ? 0.8 : 0.002;
    const n = () => (Math.random() - 0.5) * 2;
    window.dispatchEvent(new DeviceMotionEvent("devicemotion", {
      accelerationIncludingGravity: { x: k * gd.x + jit * n(), y: k * gd.y + jit * n(), z: k * gd.z + jit * n() },
      acceleration: { x: jit * n(), y: jit * n(), z: jit * n() },
      rotationRate: m.moving ? { alpha: 40 * n(), beta: 40 * n(), gamma: 40 * n() } : { alpha: 0.05 * n(), beta: 0.05 * n(), gamma: 0.05 * n() + swayRate },
      interval: 16,
    }));
  }, 16);
  const watchers = new Map(); let wid = 1;
  navigator.geolocation.watchPosition = (ok) => {
    const id = wid++;
    const tick = () => {
      const m = window.__mock;
      const j = () => (Math.random() - 0.5) * 2 * 0.000004;
      ok({ coords: { latitude: m.lat + j(), longitude: m.lon + j(), accuracy: m.acc }, timestamp: Date.now() });
    };
    tick();
    watchers.set(id, setInterval(tick, 1000));
    return id;
  };
  navigator.geolocation.clearWatch = (id) => clearInterval(watchers.get(id));
})();
""".replace("%CONV%", CONV).replace("%LAT0%", str(LAT0)).replace("%LON0%", str(LON0)).replace("%MOUNT%", "true" if MODE == "handlebar" else "false")

# 발판: 휴대폰 쪽 오프셋(카메라 범프 흉내). 거치대는 대신 mountKappa로 틀어져 꽂힘
BIAS_ROLL, BIAS_PITCH = (1.0, 0.5) if MODE == "deck" else (0.0, 0.0)
PHI = 9.0                          # 이 킥보드의 평지 스탠드 기울기

def mock(page, **kw):
    page.evaluate("(kw) => Object.assign(window.__mock, kw)", kw)

def place(page, lean, pitch=0.0, settle=0.8):
    """손으로 놓는 움직임 → 정지. lean/pitch는 킥보드 기준, 휴대폰엔 오프셋이 더해진다"""
    mock(page, moving=True)
    time.sleep(settle)
    mock(page, roll=lean + BIAS_ROLL, pitch=pitch + BIAS_PITCH, moving=False)

def move_to(page, east_m, north_m=0.0, settle=11000):
    mock(page, lat=LAT0 + north_m / 111320, lon=LON0 + east_m / M_PER_DEG_LON)
    page.wait_for_timeout(settle)  # 기본값은 이전 위치가 위치 사용 구간(10초)에서 빠지게

def measure(page, lean, pitch=0.0, n_logs=None, sway=0.0):
    mock(page, moving=True, sway=0)
    page.click("#btnMeasure")
    page.wait_for_timeout(600)
    mock(page, roll=lean + BIAS_ROLL, pitch=pitch + BIAS_PITCH, moving=False, sway=sway)
    page.wait_for_function(f"window.__pm.state.logs.length >= {n_logs} && !document.querySelector('#resultBox').hidden", timeout=25000)
    mock(page, sway=0)
    return page.inner_text("#decision")

def card_shot(page, path):
    """상단 바가 sticky라 요소 캡처 위에 겹친다. 잠깐 static으로 바꿔 찍는다"""
    page.evaluate("document.querySelector('.topbar').style.position = 'static'")
    page.locator("#resultBox").screenshot(path=path)
    page.evaluate("document.querySelector('.topbar').style.position = ''")

def result(page):
    return {"decision": page.inner_text("#decision"), "msg": page.inner_text("#decisionMsg")}

R = {}
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=CHROME, args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"])
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                              accept_downloads=True, locale="ko-KR")
    ctx.add_init_script(MOCK)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(BASE)
    page.wait_for_timeout(800)
    R["start_tab"] = page.evaluate("window.__pm.currentTab")
    R["ride_off"] = page.inner_text("#rideCard")
    page.screenshot(path=str(OUT / "00_ride_off.png"))
    page.click("#btnRideStart")
    page.wait_for_timeout(2000)
    R["ride_nozones"] = page.inner_text("#rideDist")

    page.click('.tab[data-tab="calib"]')
    R["calib_before"] = page.inner_text("#calibState")
    if MODE == "deck":
        page.click('#mountSeg button[data-mount="deck"]')
        # ---- 보정 1·2단계 (바닥 2° 기울어진 책상) ----
        mock(page, moving=True); time.sleep(0.8); mock(page, roll=2 + BIAS_ROLL, pitch=BIAS_PITCH, moving=False)
        page.click("#btnCalA")
        page.wait_for_function("document.querySelector('#calAText').textContent.startsWith('첫 번째')", timeout=15000)
        mock(page, moving=True); time.sleep(0.8); mock(page, roll=-2 + BIAS_ROLL, pitch=BIAS_PITCH, moving=False)
        page.click("#btnCalB")
        page.wait_for_function("document.querySelector('#calBText').textContent.includes('오프셋')", timeout=15000)
        R["calib"] = page.inner_text("#calBText")
        # ---- 3단계 기준 자세: 평지에 킥보드, θ = φ ----
        place(page, PHI)
        page.click("#btnCalRef")
        page.wait_for_function("document.querySelector('#calRefText').textContent.includes('저장했습니다')", timeout=15000)
        R["calib_ref"] = page.inner_text("#calRefText")
    else:
        # ---- 거치대: 평지·스탠드·핸들 편 상태로 기준 자세 한 번 ----
        place(page, PHI)
        page.click("#btnCalMount")
        page.wait_for_function("document.querySelector('#calMountText').textContent.includes('저장했습니다')", timeout=15000)
        R["calib_ref"] = page.inner_text("#calMountText")
    R["calib_state"] = page.inner_text("#calibState")
    R["chip"] = page.inner_text("#chipCalib")
    page.evaluate("window.scrollTo(0,0)")
    page.screenshot(path=str(OUT / "01_calib.png"))

    # ---- 구역: 현재 위치 기준 20 m 허용 ----
    page.click('.tab[data-tab="zones"]')
    page.wait_for_timeout(400)
    page.fill("#squareSide", "20")
    page.click("#btnSquare")
    page.wait_for_timeout(400)

    # 북쪽 120 m에 허용구역 하나 더(어느 쪽이 가까운지 고르는지 보려고)
    page.evaluate("""() => {
      const pm = window.__pm, d = 120 / 111320, w = 6 / 111320, lw = 6 / (111320 * Math.cos(37.4505 * Math.PI / 180));
      const lat = %f + d, lon = %f;
      pm.state.zones.push({ id: 'z-north', kind: 'allowed', name: '', polygon: [
        {lat: lat - w, lon: lon - lw}, {lat: lat - w, lon: lon + lw}, {lat: lat + w, lon: lon + lw}, {lat: lat + w, lon: lon - lw}] });
      localStorage.setItem('pm.zones.v1', JSON.stringify(pm.state.zones));
      pm.emit('zones-changed');
    }""" % (LAT0, LON0))

    # ---- 주행 지도 ----
    page.click('.tab[data-tab="ride"]')
    page.wait_for_timeout(3000)
    R["ride_inside"] = page.inner_text("#rideCard")
    R["ride_inside_tag"] = page.inner_text(".zone-tag")
    page.screenshot(path=str(OUT / "10_ride_inside.png"))
    move_to(page, 60, settle=3500)
    R["ride_far"] = page.inner_text("#rideCard")
    R["ride_far_tag"] = page.inner_text(".zone-tag")
    R["nearest_paths"] = page.evaluate("document.querySelectorAll('#rideMap path.zone-nearest').length")
    page.screenshot(path=str(OUT / "11_ride_far.png"))
    # 손으로 지도를 끌면 따라가기를 멈추고 '내 위치로' 버튼이 나온다
    box = page.locator("#rideMap").bounding_box()
    page.mouse.move(box["x"] + 200, box["y"] + 200); page.mouse.down(); page.mouse.move(box["x"] + 80, box["y"] + 120, steps=8); page.mouse.up()
    page.wait_for_timeout(300)
    R["recenter_after_drag"] = page.is_visible("#btnRecenter")
    page.click("#btnRecenter")
    page.wait_for_timeout(800)
    R["recenter_after_click"] = page.is_visible("#btnRecenter")
    page.click("#btnRideReturn")
    page.wait_for_timeout(300)
    R["tab_after_return"] = page.evaluate("window.__pm.currentTab")

    # ---- S3 구역 밖 (동쪽 60 m) → 이제는 사진 ----
    page.wait_for_timeout(8000)
    place(page, PHI)
    page.wait_for_timeout(1500)
    R["preview_outside"] = page.inner_text("#previewStrip")
    R["S3"] = measure(page, PHI, n_logs=1)
    R["S3_msg"] = page.inner_text("#decisionMsg")
    R["S3_next"] = page.inner_text("#nextStep")
    card_shot(page, str(OUT / "06_S3_outside_photo.png"))

    # ---- 미리보기 (구역 안으로 돌아와서) ----
    move_to(page, 0)
    place(page, PHI)
    page.wait_for_timeout(1500)
    R["preview_flat"] = page.inner_text("#previewStrip")
    page.screenshot(path=str(OUT / "02_preview_ok.png"))
    place(page, 3.0)
    page.wait_for_timeout(1500)
    R["preview_tilted"] = page.inner_text("#previewStrip")
    page.screenshot(path=str(OUT / "03_preview_tilted.png"))

    # ---- S1 정상 ----
    R["S1"] = measure(page, PHI, n_logs=2)
    page.click('#labelSeg button[data-label="correct"]')
    page.evaluate("window.scrollTo(0,0)")
    page.screenshot(path=str(OUT / "04_S1_pass.png"))

    # ---- S2 경사 ----
    R["S2"] = measure(page, 3.0, n_logs=3)
    R["S2_msg"] = page.inner_text("#decisionMsg")

    # ---- S4 넘어짐 ----
    R["S4"] = measure(page, 85.0, n_logs=4)
    R["S4_msg"] = page.inner_text("#decisionMsg")
    page.evaluate("window.scrollTo(0,0)")
    page.screenshot(path=str(OUT / "05_S4_fallen.png"))

    # ---- S6 흔들림 + 경사: 평균 16°에서 ±6° (통과 구간 5°~19°) ----
    t0 = time.time()
    R["S6"] = measure(page, 16.0, n_logs=5, sway=6.0)
    R["S6_seconds"] = round(time.time() - t0, 1)
    R["S6_msg"] = page.inner_text("#decisionMsg")
    R["S6_sway_row"] = page.inner_text("#checkList li:has(.name:text('흔들림'))")
    card_shot(page, str(OUT / "07_S6_sway.png"))

    # ---- S5 경계 → 사진 폴백 ----
    move_to(page, 10)  # 20 m 구역의 동쪽 경계선 위
    R["S5"] = measure(page, PHI, n_logs=6)
    img = OUT / "fake_photo.png"
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (1200, 900), (200, 210, 205)); ImageDraw.Draw(im).rectangle([400, 200, 800, 700], fill=(40, 60, 80)); im.save(img)
    page.set_input_files("#nextStep input[type=file]", str(img))
    page.wait_for_selector("#nextStep .photo-done", timeout=5000)
    R["S5_photo_kb"] = page.evaluate("Math.round(window.__pm.state.logs[0].photo.length * 3 / 4 / 1024)")
    card_shot(page, str(OUT / "08_S5_photo.png"))

    # ---- 기록 지도 ----
    page.click('.tab[data-tab="zones"]')
    page.wait_for_timeout(500)
    before = page.evaluate("document.querySelectorAll('#map path.leaflet-interactive').length")
    page.check("#showLogs")
    page.wait_for_timeout(400)
    after = page.evaluate("document.querySelectorAll('#map path.leaflet-interactive').length")
    R["log_markers_added"] = after - before
    page.evaluate("window.scrollTo(0,0)")
    page.screenshot(path=str(OUT / "09_log_map.png"))

    # ---- 기록·CSV ----
    page.click('.tab[data-tab="logs"]')
    page.wait_for_timeout(300)
    R["summary"] = page.inner_text("#logSummary")
    with page.expect_download() as dl:
        page.click("#btnCsv")
    csv = OUT / "export.csv"; dl.value.save_as(str(csv))
    head = csv.read_text(encoding="utf-8-sig").splitlines()
    R["csv_has_photo_col"] = "hasPhoto" in head[0]
    R["csv_rows"] = len(head) - 1

    R["errors"] = [e for e in errors if "ERR_TUNNEL" not in e and "favicon" not in e]
    browser.close()

print(json.dumps(R, ensure_ascii=False, indent=1))
