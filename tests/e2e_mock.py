"""헤드리스 Chrome으로 웹 실험 도구 전체 흐름을 모의 센서로 돌린다.
사용: python3 tests/e2e_mock.py <base_url> <screenshot_dir> <convention: spec|ios>
센서 부호 규약: spec = 화면 위일 때 z=+9.8(W3C 명세), ios = 반대 부호.
Chrome 경로는 executable_path에서 바꾸세요.
"""
import json, sys, time, pathlib
from playwright.sync_api import sync_playwright

BASE, OUT, CONV = sys.argv[1], pathlib.Path(sys.argv[2]), sys.argv[3]
OUT.mkdir(parents=True, exist_ok=True)

MOCK = r"""
(() => {
  const G0 = 9.80665;
  const d2r = (d) => d * Math.PI / 180;
  window.__mock = { roll: 0, pitch: 0, moving: false, conv: "%CONV%", lat: 37.45050, lon: 126.65370, acc: 4.0 };
  // 화면이 위로 놓인 상태 기준. spec: 화면 위 z=+9.8 / ios: 반대 부호
  setInterval(() => {
    const m = window.__mock;
    const r = d2r(m.roll), p = d2r(m.pitch);
    const gd = { x: -Math.sin(r) * Math.cos(p), y: Math.sin(p), z: -Math.cos(r) * Math.cos(p) };
    const k = m.conv === "spec" ? -G0 : G0;
    const jit = m.moving ? 0.8 : 0.002;
    const n = () => (Math.random() - 0.5) * 2;
    const ev = new DeviceMotionEvent("devicemotion", {
      accelerationIncludingGravity: { x: k * gd.x + jit * n(), y: k * gd.y + jit * n(), z: k * gd.z + jit * n() },
      acceleration: { x: jit * n(), y: jit * n(), z: jit * n() },
      rotationRate: m.moving ? { alpha: 40 * n(), beta: 40 * n(), gamma: 40 * n() } : { alpha: 0.05 * n(), beta: 0.05 * n(), gamma: 0.05 * n() },
      interval: 16,
    });
    window.dispatchEvent(ev);
  }, 16);

  // watchPosition을 가짜로 바꾼다. 1초마다 약간 흔들리는 위치를 보낸다
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
""".replace("%CONV%", CONV)

def mock(page, **kw):
    page.evaluate("(kw) => Object.assign(window.__mock, kw)", kw)

def place(page, roll, pitch, settle=0.8):
    """손으로 놓는 움직임 → 정지"""
    mock(page, moving=True)
    time.sleep(settle)
    mock(page, roll=roll, pitch=pitch, moving=False)

results = {}
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                              accept_downloads=True, locale="ko-KR")
    ctx.add_init_script(MOCK)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(BASE)
    page.wait_for_timeout(600)
    page.screenshot(path=str(OUT / "01_initial.png"), full_page=False)
    results["hidden_ok_initial"] = page.evaluate("getComputedStyle(document.querySelector('#btnAbort')).display")

    page.click("#btnSensorsOn")
    page.wait_for_timeout(2500)
    results["chips_after_start"] = [page.inner_text(s) for s in ("#chipMotion", "#chipGps", "#chipCalib")]
    results["sensors_btn_display"] = page.evaluate("getComputedStyle(document.querySelector('#btnSensorsOn')).display")

    # ---- 보정: 바닥 좌우 2°, 휴대폰 오프셋 좌우 1.0°, 앞뒤 0.5° ----
    page.click('.tab[data-tab="calib"]')
    place(page, roll=2 + 1.0, pitch=0 + 0.5)
    page.click("#btnCalA")
    page.wait_for_function("document.querySelector('#calAText').textContent.startsWith('첫 번째')", timeout=15000)
    place(page, roll=-2 + 1.0, pitch=0 + 0.5)
    page.click("#btnCalB")
    page.wait_for_function("document.querySelector('#calBText').textContent.includes('오프셋')", timeout=15000)
    results["calib_text"] = page.inner_text("#calBText")
    results["calib_state"] = page.evaluate("({bias: window.__pm.state.bias, sign: window.__pm.state.sign})")
    page.screenshot(path=str(OUT / "02_calib.png"), full_page=True)

    # ---- 구역: 현재 위치 기준 20 m 허용 구역 ----
    page.click('.tab[data-tab="zones"]')
    page.wait_for_timeout(500)
    page.fill("#squareSide", "20")
    page.click("#btnSquare")
    page.wait_for_timeout(600)
    page.click('#zoneKindSeg button[data-kind="forbidden"]')
    page.click("#btnDraw")
    results["draw_buttons_visible"] = page.evaluate("['#btnDraw','#btnDrawUndo','#btnDrawDone','#btnDrawCancel'].map(s => !document.querySelector(s).hidden)")
    box = page.locator("#map").bounding_box()
    for fx, fy in [(0.80, 0.70), (0.95, 0.70), (0.95, 0.92), (0.80, 0.92)]:
        page.mouse.click(box["x"] + box["width"] * fx, box["y"] + box["height"] * fy)
        page.wait_for_timeout(150)
    results["draw_hint"] = page.inner_text("#drawHint")
    page.click("#btnDrawDone")
    page.wait_for_timeout(400)
    results["zones"] = page.evaluate("window.__pm.state.zones.map(z => z.kind)")
    page.evaluate("window.scrollTo(0, 0)")
    page.screenshot(path=str(OUT / "03_zones.png"), full_page=False)

    # ---- 판정 1: 킥보드 좌우 8°(휴대폰엔 오프셋 1°가 더해짐) → 사진 없이 반납 기대 ----
    page.click('.tab[data-tab="check"]')
    mock(page, moving=True)
    page.click("#btnMeasure")
    page.wait_for_timeout(700)
    page.screenshot(path=str(OUT / "04_measuring.png"), full_page=False)
    mock(page, roll=8 + 1.0, pitch=0.5, moving=False)
    page.wait_for_selector("#resultBox:not([hidden])", timeout=25000)
    results["run1_decision"] = page.inner_text("#decision")
    results["run1_checks"] = page.inner_text("#checkList")
    page.click('#labelSeg button[data-label="correct"]')
    page.fill("#memoInput", "평지, 20m 구역 중앙")
    page.press("#memoInput", "Enter")
    page.locator("#memoInput").blur()
    page.wait_for_timeout(300)
    page.locator("#resultBox").screenshot(path=str(OUT / "05_result_pass.png"))
    page.evaluate("window.scrollTo(0, 0)")
    page.screenshot(path=str(OUT / "05b_top_after_pass.png"), full_page=False)

    # ---- 판정 2: 바닥이 스탠드 반대쪽으로 기움(θ = -2°) → 다시 세우기 기대 ----
    mock(page, moving=True)
    page.click("#btnMeasure")
    page.wait_for_timeout(600)
    mock(page, roll=-2 + 1.0, pitch=0.5, moving=False)
    page.wait_for_function("document.querySelector('#decision').textContent && !document.querySelector('#resultBox').hidden && window.__pm.state.logs.length >= 2", timeout=25000)
    results["run2_decision"] = page.inner_text("#decision")
    page.click('#labelSeg button[data-label="wrong"]')
    page.evaluate("window.scrollTo(0, 0)")
    page.screenshot(path=str(OUT / "06_result_reject.png"), full_page=False)

    # ---- 판정 3: 구역에서 멀리(70 m 동쪽) → 다시 세우기, 정확도 12 m → 사진 ----
    mock(page, lat=37.45050, lon=126.65370 + 0.00079, acc=4.0)
    page.wait_for_timeout(11000)  # 이전 위치가 위치 구간(10초)에서 빠지게
    mock(page, moving=True)
    page.click("#btnMeasure")
    page.wait_for_timeout(600)
    mock(page, roll=8 + 1.0, pitch=0.5, moving=False)
    page.wait_for_function("window.__pm.state.logs.length >= 3 && !document.querySelector('#resultBox').hidden", timeout=25000)
    results["run3_decision"] = page.inner_text("#decision")
    results["run3_location"] = [c for c in page.evaluate("window.__pm.state.logs[0].checks") if c["name"] == "location"][0]

    # ---- 기록 ----
    page.click('.tab[data-tab="logs"]')
    page.wait_for_timeout(400)
    results["summary"] = page.inner_text("#logSummary")
    page.screenshot(path=str(OUT / "07_logs.png"), full_page=True)
    with page.expect_download() as dl:
        page.click("#btnCsv")
    csv_path = OUT / "export.csv"
    dl.value.save_as(str(csv_path))
    results["csv_head"] = csv_path.read_text(encoding="utf-8-sig").splitlines()[:2]

    # ---- 센서·설정 ----
    page.click('.tab[data-tab="sensors"]')
    page.wait_for_timeout(600)
    page.screenshot(path=str(OUT / "08_sensors.png"), full_page=True)
    page.click('.tab[data-tab="settings"]')
    page.wait_for_timeout(300)
    page.check("#set-useGeometry")
    page.wait_for_timeout(200)
    results["geo_computed"] = page.inner_text("#geoComputed")
    page.click("#btnSaveSettings")
    page.wait_for_timeout(300)
    results["cfg_after_save"] = page.evaluate("({minLean: window.__pm.rad2deg(window.__pm.state.cfg.minLean), maxLean: window.__pm.rad2deg(window.__pm.state.cfg.maxLean), geo: window.__pm.state.cfg.geometry})")
    page.screenshot(path=str(OUT / "09_settings.png"), full_page=False)

    # 실측값 적용 후 판정 탭 도식(도식 라벨이 사라져야 함)
    page.click('.tab[data-tab="check"]')
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / "10_check_after_geo.png"), full_page=False)

    results["errors"] = errors
    browser.close()

print(json.dumps(results, ensure_ascii=False, indent=1))
