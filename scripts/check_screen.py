"""Kiểm màn chiếu bằng Playwright (Edge thật): máy chiếu 1920×1080 + Admin + 1 CTV (iPhone 13, chạm).
    python scripts/check_screen.py <thư mục chứa 3 tệp .pptx mẫu>
Tự bật server cổng 4199 với DATA_FILE tạm (không đụng data.json). Đề mẫu KHÔNG nằm trong repo.
1) Đọc cả 3 pptx qua API: đếm vòng/câu, không lỗi, đối chiếu đáp án + ảnh với slide (BỘ ĐỀ 1).
2) Admin chọn BỘ ĐỀ 1 → Đọc & xem trước → Lưu (bấm thật trên trang).
3) Chạy hết 3 vòng × 10 câu: Mở vòng → Hiện câu → Play → hết giờ → Đáp án → (CTV chạm 4 bạn liên tiếp, chờ qua vòng
   đồng bộ 4 s, Gửi) → Đóng → Câu tiếp. Mỗi câu kiểm: đúng "Câu số N"; trước Play KHÔNG có phương án/đáp án trong dữ liệu;
   trước Đáp án KHÔNG có đáp án; đúng tệp nhạc đang phát và currentTime tăng; Đáp án chỉ còn phương án đúng / hiện đáp án mẫu.
4) Hiện bảng điểm (đối chiếu điểm) → Màn kết thúc (âm kết).
Ảnh: shots/ (đã .gitignore vì có nội dung đề). Dòng cuối KET_QUA=PASS|FAIL."""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "shots"
PORT = 4199
BASE = f"http://127.0.0.1:{PORT}"
KEY = "kiem-thu-" + __import__("secrets").token_urlsafe(8)   # mã quản trị tạm cho lần kiểm
DECKS = ["BỘ ĐỀ 1.pptx", "BỘ ĐỀ 2_LỚP 5.pptx", "Bộ đề nâng cao phụ.pptx"]
# BỘ ĐỀ 1 — đáp án đọc bằng mắt trên slide (phương án còn lại khi bấm Đáp án) + câu có ảnh minh hoạ
DECK1_ANSWERS = {1: "A", 2: "C", 3: "C", 4: "B", 5: "D", 6: "B", 7: "D", 8: "C", 9: "B", 10: "B"}
DECK1_NO_IMAGE = {3, 10}
fails = []


def check(name, cond, extra=""):
    print(("OK  " if cond else "FAIL"), name, extra, flush=True)
    if not cond:
        fails.append(name)


def api(path, body=None, raw=None):
    h = {"X-Admin-Key": KEY, "Content-Type": "application/octet-stream" if raw is not None else "application/json"}
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(urllib.request.Request(BASE + path, data=data, headers=h), timeout=60) as r:
        return json.loads(r.read())


def main():
    deck_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "rcv-live-de-mau"
    SHOTS.mkdir(exist_ok=True)
    data_file = Path(tempfile.mkdtemp()) / "data.json"
    srv = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=dict(os.environ, PORT=str(PORT), DATA_FILE=str(data_file), ADMIN_KEY=KEY),
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(BASE + "/robots.txt", timeout=2)
                break
            except OSError:
                time.sleep(0.2)
        check_locks()
        check_decks(deck_dir)
        run(deck_dir)
    finally:
        srv.terminate()
        srv.wait(10)
    compare_shots(deck_dir)
    print("KET_QUA=" + ("PASS" if not fails else "FAIL " + "; ".join(fails[:6])))
    return not fails


def code(url, headers=None):
    try:
        with urllib.request.urlopen(urllib.request.Request(BASE + url, headers=headers or {}), timeout=10) as r:
            return r.status, dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers)


def check_locks():
    ov = api("/api/admin/overview")
    check("Khoá: /api/screen, /api/leaderboard thiếu mã → 401", code("/api/screen")[0] == 401 and code("/api/leaderboard")[0] == 401)
    check("Khoá: mã màn chiếu đúng → 200", code("/api/screen?k=" + ov["screenKey"])[0] == 200)
    check("Khoá: CTV 'ctv1' (mã cũ dễ đoán) → 404; mã ngẫu nhiên → 200",
          code("/api/ctv/ctv1")[0] == 404 and code("/api/ctv/" + ov["ctvStatus"][0]["token"])[0] == 200
          and all(len(c["token"]) >= 12 for c in ov["ctvStatus"]))
    st, h = code("/admin.html")
    check("Mọi trang: noindex + no-store", st == 200 and "noindex" in h.get("X-Robots-Tag", "") and h.get("Cache-Control") == "no-store")
    check("robots.txt chặn hết", "Disallow: /" in urllib.request.urlopen(BASE + "/robots.txt").read().decode())


def check_decks(deck_dir):
    # cách nhập phụ: dán 8 cột từ Excel (Tab) — xem trước + báo lỗi đúng dòng
    T = "\t"
    rows = [T.join(["Vòng", "Câu", "Đề bài", "A", "B", "C", "D", "Đáp án"])] + [
        T.join([str(r), str(q), f"Câu {q}: Which word means “quả táo”?", "banana", "apple", "orange", "grape", "B"]) if q % 2 else
        T.join([str(r), str(q), "Điền từ: We ___ students.", "", "", "", "", "are"]) for r in (1, 2) for q in range(1, 11)]
    text = "\n".join(rows)
    ok = api("/api/admin/questions", {"text": text, "save": False})
    broken = text.replace("1\t3\t", "1\t3x\t").replace("\tB\n1\t6", "\tE\n1\t6")
    bad = api("/api/admin/questions", {"text": broken, "save": False})
    check("Dán Excel: 20 câu không lỗi; bản lỗi báo đúng dòng", len(ok["rows"]) == 20 and not ok["errors"]
          and any("Dòng 4" in e for e in bad["errors"]) and any('"E"' in e for e in bad["errors"]), str(bad["errors"]))
    expect = {DECKS[0]: [10, 10, 10], DECKS[1]: [10, 10, 10], DECKS[2]: [10, 10, 10, 10]}
    for name in DECKS:
        d = api("/api/admin/pptx", raw=(deck_dir / name).read_bytes())
        counts = [len(r["questions"]) for r in d["rounds"]]
        check(f"{name}: {len(counts)} vòng, số câu {counts}, không lỗi", counts == expect[name] and not d["errors"],
              f"{[r['title'] for r in d['rounds']]} lỗi={d['errors']}")
        qs = [q for r in d["rounds"] for q in r["questions"]]
        mcq = [q for q in qs if q["options"]]
        check(f"{name}: mọi câu trắc nghiệm có 4 phương án + 1 đáp án A–D, câu tự luận có đáp án mẫu",
              all(len(q["options"]) == 4 and q["answer"] in "ABCD" for q in mcq) and all(q["answer"] for q in qs if not q["options"]))
        check(f"{name}: mọi câu có nhạc đếm + số giây", all(q["sndPlay"] and q["seconds"] in (10, 15) for q in qs),
              str(sorted({q["seconds"] for q in qs})))
        if name == DECKS[0]:
            got = {q["label"]: q["answer"] for q in qs if q["label"] <= 10}
            check("BỘ ĐỀ 1: đáp án câu 1–10 khớp slide (phương án còn lại khi bấm Đáp án)", got == DECK1_ANSWERS, str(got))
            noimg = {q["label"] for q in qs if q["label"] <= 10 and not q["image"]}
            check("BỘ ĐỀ 1: ảnh minh hoạ đúng câu (câu 3, 10 không có ảnh)", noimg == DECK1_NO_IMAGE, str(noimg))
            check("BỘ ĐỀ 1: có ghi chú lệch tên hình 'dap an dung'", len(d["warnings"]) > 0, f"{len(d['warnings'])} lưu ý")


def run(deck_dir):
    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge", headless=True, args=["--autoplay-policy=user-gesture-required"])
        adm_ctx = b.new_context(viewport={"width": 1280, "height": 900})
        adm = adm_ctx.new_page()
        adm.on("dialog", lambda dl: dl.accept())
        adm.goto(BASE + "/admin.html")
        adm.fill("#adminKey", KEY)
        adm.dispatch_event("#adminKey", "change")
        adm.set_input_files("#pptxFile", str(deck_dir / DECKS[0]))
        adm.click("text=Đọc tệp & xem trước")
        adm.wait_for_function("document.getElementById('pMsg').textContent.includes('Đọc được 3 vòng, 30 câu')", timeout=60000)
        adm.screenshot(path=str(SHOTS / "admin-xem-truoc-pptx.png"), full_page=True)
        adm.click("#pptxSave")
        adm.wait_for_function("document.getElementById('pMsg').textContent.includes('Đã lưu 30 câu')")
        ov = api("/api/admin/overview")
        check("Admin: nhập BỘ ĐỀ 1 qua trang (30 câu)", ov["questionCount"] == 30)
        img = next(q["image"] for q in [ov["currentQuestion"]] if q["image"])
        check("Khoá: ảnh đề thiếu mã → 401, có mã → 200", code("/media/" + img)[0] == 401 and code(f"/media/{img}?k={ov['screenKey']}")[0] == 200)
        sk, ctv_token = ov["screenKey"], ov["ctvStatus"][0]["token"]

        scr = b.new_context(viewport={"width": 1920, "height": 1080}).new_page()
        seen = []
        def keep(r):
            if "/api/screen" in r.url and r.status == 200:
                try:
                    seen.append(r.json())
                except Exception:  # noqa: BLE001 — trình duyệt đã đóng
                    pass
        scr.on("response", keep)
        scr.goto(BASE + "/screen.html?k=" + sk)
        scr.click("#unlockBtn")
        dev = dict(p.devices["iPhone 13"]); dev.pop("default_browser_type", None)
        ctv = b.new_context(**dev).new_page()
        ctv.goto(BASE + "/ctv.html?token=" + ctv_token)
        ctv.wait_for_selector(".card")

        def step(s):
            adm.click(f"#step-{s}")
            adm.wait_for_timeout(150)

        def wait_screen(cond, t=8000):
            scr.wait_for_function(cond, timeout=t)

        def audio():
            return scr.evaluate("({src: document.getElementById('sfx').currentSrc, t: document.getElementById('sfx').currentTime, "
                                "paused: document.getElementById('sfx').paused})")

        expected = {1: 0.0, 2: 0.0, 3: 0.0, 4: 0.0}
        n_done = 0
        while True:
            ov = api("/api/admin/overview")
            rnd, qn, cq = ov["round"], ov["question"], ov["currentQuestion"]
            label = f"V{rnd}C{qn} (Câu số {cq['label']})"
            if qn == 1:
                step("opener")
                wait_screen("document.querySelector('.vong') && document.querySelector('.vong').textContent.length > 0")
                check(f"{label}: slide mở vòng '{ov['roundTitle']}'", ov["roundTitle"] in scr.inner_text("#stage"))
                if rnd in (1, 3):
                    scr.screenshot(path=str(SHOTS / f"0-mo-vong-{rnd}.png"))
            # 1) đề + ảnh + nút Play
            step("question")
            wait_screen(f"document.querySelector('.label') && document.querySelector('.label').textContent.trim() === 'Câu số {cq['label']}'")
            mark = len(seen)
            check(f"{label}: chưa Play → không có phương án, không nút ???", scr.locator(".opt").count() == 0
                  and scr.locator("#btn.play").count() == 1)
            secs = adm.input_value("#secs")
            check(f"{label}: Admin điền sẵn số giây theo slide ({cq['seconds']})", secs == str(cq["seconds"]), secs)
            if n_done == 0:
                scr.wait_for_timeout(600)
                scr.screenshot(path=str(SHOTS / "1-de.png"))
            if cq["options"] is None and rnd == 3 and qn == 1:
                scr.screenshot(path=str(SHOTS / "5-tu-luan-de.png"))
            # 2) Play: phương án + đếm ngược + nhạc (đếm nhanh 2 giây cho kịch bản, riêng câu đầu đủ giây theo slide)
            if n_done:
                adm.fill("#secs", "2")
            step("play")
            if cq["options"]:
                wait_screen("document.querySelectorAll('.opt').length === 4")
            wait_screen("document.getElementById('count').textContent !== ''")
            scr.wait_for_timeout(1200)
            a1 = audio()
            scr.wait_for_timeout(700)
            a2 = audio()
            check(f"{label}: Play → đúng nhạc của slide ({cq['sndPlay'][:14]}…) đang phát",
                  ("/media/" + cq["sndPlay"] + "?") in a1["src"] and not a2["paused"] and a2["t"] > a1["t"], json.dumps(a2))
            if n_done == 0:
                scr.screenshot(path=str(SHOTS / "2-dang-dem.png"))
            wait_screen("document.querySelector('#btn.dapan')", t=int(cq["seconds"]) * 1000 + 4000)
            if n_done == 0:
                scr.screenshot(path=str(SHOTS / "3-het-gio.png"))
            leak = [x for x in seen[mark:] if x.get("q") and "answer" in x["q"]]
            pre = [x for x in seen[:mark] if x.get("q") and ("options" in x["q"] or "answer" in x["q"]) and x["step"] == "question"]
            check(f"{label}: trước Đáp án dữ liệu màn chiếu không có đáp án; trước Play không có phương án", not leak and not pre)
            # CTV chấm 4 bạn liên tiếp (kịch bản lỗi cũ) rồi Gửi
            ctv.wait_for_function(f"document.getElementById('statePill').textContent.includes('Câu {qn}')", timeout=10000)
            want = {1: True, 2: False, 3: True, 4: qn % 2 == 0}
            for n in (1, 2, 3, 4):
                ctv.locator(".card", has_text=f"#{n}").nth(0).locator(".btn-ok" if want[n] else ".btn-bad").tap()
                ctv.wait_for_timeout(200)
            ctv.wait_for_timeout(4500)
            active = {n: ctv.locator(".card", has_text=f"#{n}").nth(0).locator(".btn-ok.active").count() == 1 for n in want}
            check(f"{label}: CTV sau 4 s vẫn giữ đủ 4 lượt chạm", active == want, str(active))
            ctv.locator("#submitBtn").tap()
            ctv.wait_for_function("document.querySelector('.status-line').textContent.includes('Đã gửi')", timeout=10000)
            for n in want:
                if want[n]:
                    expected[n] += {1: 1, 2: 1.5}.get(rnd, 0)
            # 3) Đáp án
            step("answer")
            if cq["options"]:
                wait_screen("document.querySelectorAll('.opt.hide').length === 3")
                left = scr.locator(".opt:not(.hide)").get_attribute("data-l")
                check(f"{label}: Đáp án → chỉ còn phương án đúng {cq['answer']}", left == cq["answer"], left)
            else:
                wait_screen("document.getElementById('model')")
                check(f"{label}: Đáp án → hiện đáp án mẫu", scr.inner_text("#model").strip() == cq["answer"].strip())
            if cq.get("sndAnswer"):
                scr.wait_for_timeout(1500)
                a = audio()
                check(f"{label}: Đáp án → phát âm công bố của slide", ("/media/" + cq["sndAnswer"] + "?") in a["src"] and not a["paused"],
                      json.dumps(a))
            else:
                scr.wait_for_timeout(1300)
                check(f"{label}: Đáp án → dừng nhạc đếm", audio()["paused"])
            if n_done == 0:
                scr.screenshot(path=str(SHOTS / "4-dap-an.png"))
            if cq["options"] is None and rnd == 3 and qn == 1:
                scr.screenshot(path=str(SHOTS / "6-tu-luan-dap-an.png"))
            n_done += 1
            adm.click("text=Đóng câu hiện tại")
            adm.wait_for_timeout(200)
            before = (rnd, qn)
            adm.click("text=Sang câu tiếp →")
            adm.wait_for_timeout(400)
            st = api("/api/admin/overview")
            if (st["round"], st["question"]) == before or st["status"] == "finished":
                break
            check(f"{label}: sang câu tiếp → màn chiếu về {'mở vòng' if st['round'] != rnd else 'đề'}, nhạc dừng",
                  api("/api/screen")["step"] == ("opener" if st["round"] != rnd else "question"))
        check("Chạy hết 30 câu", n_done == 30, str(n_done))
        step("leaderboard")
        scr.wait_for_selector("#lb", state="visible", timeout=10000)
        scr.frame_locator("#lb").locator(".row").first.wait_for(timeout=10000)
        scr.wait_for_timeout(1500)
        scr.screenshot(path=str(SHOTS / "7-bang-diem.png"))
        lb = {r["number"]: r["score"] for r in api("/api/leaderboard")["rows"]}
        check("Bảng điểm khớp lượt CTV chấm (vòng C loại trực tiếp: 0 điểm)", all(abs(lb[n] - expected[n]) < 1e-9 for n in expected),
              str({n: (lb[n], expected[n]) for n in expected}))
        step("end")
        scr.wait_for_timeout(2000)
        a = audio()
        check("Màn kết thúc → âm kết của slide", "/media/snd-" in a["src"] and (not a["paused"] or a["t"] > 0), json.dumps(a))
        scr.screenshot(path=str(SHOTS / "8-ket-thuc.png"))
        # thử sai mã quản trị liên tục → bị chặn 429
        bad = [code("/api/admin/overview", {"X-Admin-Key": "sai"})[0] for _ in range(11)]
        # bộ đếm theo IP gộp mọi lần sai (kể cả thiếu mã màn chiếu ở trên): tối đa 10 lần sai trong 15 phút rồi 429
        first = bad.index(429) if 429 in bad else None
        check("Khoá: thử sai mã quản trị liên tục → bị chặn 429 (≤ 10 lần sai/15 phút/IP)",
              first is not None and all(x == 401 for x in bad[:first]) and all(x == 429 for x in bad[first:]), str(bad))
        b.close()


def compare_shots(deck_dir):
    """Ghép ảnh màn chiếu cạnh slide gốc (s1.png = mở vòng, s2.png = câu 1) để Điều phối so."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return
    pairs = [("s1.png", "0-mo-vong-1.png", "so-sanh-mo-vong.png"), ("s2.png", "2-dang-dem.png", "so-sanh-cau-1.png")]
    for orig, ours, out in pairs:
        if not (deck_dir / orig).exists() or not (SHOTS / ours).exists():
            continue
        a = Image.open(deck_dir / orig).convert("RGB").resize((960, 540))
        c = Image.open(SHOTS / ours).convert("RGB").resize((960, 540))
        im = Image.new("RGB", (1940, 580), "white")
        im.paste(a, (0, 40)); im.paste(c, (980, 40))
        d = ImageDraw.Draw(im)
        try:
            from PIL import ImageFont
            f = ImageFont.truetype("arial.ttf", 22)
        except OSError:
            f = None
        d.text((10, 8), "SLIDE GỐC (PowerPoint)", fill="black", font=f); d.text((990, 8), "MÀN CHIẾU /screen.html", fill="black", font=f)
        im.save(SHOTS / out)


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
