"""
موقع محلي لاستخراج (رقم الحساب/المكنة - المبلغ - التاريخ) من صور جدول المدفوعات
بدون أي API - كله أوفلاين على جهازك.

التثبيت (مرة واحدة):
    pip install easyocr opencv-python-headless numpy flask

التشغيل:
    python main.py
ثم افتح المتصفح على:  http://localhost:5000
"""
import re, json, statistics, urllib.request
import cv2
import numpy as np
import easyocr
from flask import Flask, request, jsonify, Response

# ======= إعدادات =======
# لو عايز زرار "إرسال للسيستم" يبعت النتايج لموقعك، اكتب رابط الـ API بتاعك هنا
# (هيتبعت POST بصيغة JSON). سيبه فاضي لو مش محتاج.
SEND_URL = ""
PORT = 5000
# =======================

print("جاري تحميل موديل القراءة... (أول مرة بتاخد وقت)")
_reader = easyocr.Reader(["en"], gpu=False)

ALLOW = "0123456789,:-. "
TIME_RE = re.compile(r"(\d{1,2})\s*[:;.]\s*(\d{2})")
DATE_RE = re.compile(r"(20\d{2})\s*-\s*(\d{2})\s*-\s*(\d{2})")


def preprocess(img):
    h, w = img.shape[:2]
    scale = 1800 / max(h, w)
    if scale > 1:
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(gray)
    gray = cv2.GaussianBlur(gray, (0, 0), 1.0)
    return cv2.addWeighted(gray, 1.8, cv2.GaussianBlur(gray, (0, 0), 3), -0.8, 0)


def ocr_boxes(img):
    out = []
    for box, text, conf in _reader.readtext(img, allowlist=ALLOW, detail=1, paragraph=False):
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        out.append({"text": text.strip(), "x": sum(xs) / 4, "y": sum(ys) / 4})
    return out


def parse(boxes):
    anchors = [b for b in boxes if ":" in b["text"] and TIME_RE.search(b["text"])]
    if not anchors:
        return []
    anchors.sort(key=lambda b: b["y"])
    ys = [a["y"] for a in anchors]
    pitch = statistics.median(b - a for a, b in zip(ys, ys[1:])) if len(ys) > 1 else 80
    tol = pitch * 0.48

    others = [b for b in boxes if b not in anchors]
    rows = []
    for a in anchors:
        near = [b for b in others if abs(b["y"] - a["y"]) <= tol and re.search(r"\d", b["text"])]
        near.sort(key=lambda b: b["x"])

        date = DATE_RE.search(a["text"])
        t = TIME_RE.search(a["text"])
        date_str = f"{date.group(1)}-{date.group(2)}-{date.group(3)} " if date else ""
        date_str += f"{int(t.group(1)):02d}:{t.group(2)}"

        nums = [b for b in near if b["x"] > a["x"]]
        account, amount = "", ""
        if nums:
            account = re.sub(r"\D", "", nums[-1]["text"])
            if len(nums) >= 2:
                amount = re.sub(r"\D", "", nums[-2]["text"])
        rows.append({
            "account": account,
            "amount": amount,
            "datetime": date_str,
            "needs_review": (not account) or (not amount) or not (4 <= len(account) <= 8),
        })
    return rows


app = Flask(__name__)


@app.get("/")
def index():
    return Response(PAGE.replace("__CAN_SEND__", "true" if SEND_URL else "false"),
                    mimetype="text/html")


@app.post("/extract")
def extract():
    data = np.frombuffer(request.files["image"].read(), np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        return jsonify({"error": "الملف مش صورة صالحة"}), 400
    return jsonify(parse(ocr_boxes(preprocess(img))))


@app.post("/send")
def send():
    if not SEND_URL:
        return jsonify({"error": "SEND_URL غير مضبوط في main.py"}), 400
    body = json.dumps(request.get_json(), ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(SEND_URL, data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return jsonify({"ok": True, "status": r.status})
    except Exception as e:
        return jsonify({"error": str(e)}), 502


PAGE = r"""<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>استخراج المدفوعات من الصور</title>
<style>
  :root { --bg:#f4f6f8; --card:#fff; --text:#1d2733; --muted:#6b7785; --line:#e2e7ec;
          --brand:#0f8b8d; --warn:#fff4d6; --warn-line:#f0c24b; --bad:#c0392b; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#12171c; --card:#1b222a; --text:#e8edf2; --muted:#93a0ad; --line:#2c3641;
            --warn:#3a3118; --warn-line:#8a6d1c; }
  }
  * { box-sizing:border-box; }
  body { margin:0; font-family:Tahoma, "Segoe UI", Arial, sans-serif; background:var(--bg); color:var(--text); }
  .wrap { max-width:900px; margin:0 auto; padding:20px 14px 60px; }
  h1 { font-size:22px; margin:6px 0 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; margin-bottom:16px; }
  #drop { border:2px dashed var(--line); border-radius:12px; padding:34px 14px; text-align:center;
          color:var(--muted); cursor:pointer; transition:.15s; }
  #drop.over { border-color:var(--brand); background:rgba(15,139,141,.07); color:var(--text); }
  #drop b { color:var(--brand); }
  .previews { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
  .previews img { height:64px; border-radius:8px; border:1px solid var(--line); }
  .status { margin-top:10px; color:var(--muted); font-size:14px; min-height:20px; }
  .toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:12px; }
  button { font:inherit; padding:9px 14px; border-radius:9px; border:1px solid var(--line);
           background:var(--card); color:var(--text); cursor:pointer; }
  button.primary { background:var(--brand); border-color:var(--brand); color:#fff; }
  button:disabled { opacity:.5; cursor:default; }
  .spacer { flex:1; }
  .table-scroll { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; min-width:560px; }
  th, td { padding:6px; border-bottom:1px solid var(--line); text-align:right; }
  th { font-size:13px; color:var(--muted); font-weight:600; }
  td input { width:100%; font:inherit; padding:7px 8px; border:1px solid transparent; border-radius:7px;
             background:transparent; color:var(--text); direction:ltr; text-align:right; }
  td input:focus { border-color:var(--brand); background:var(--bg); outline:none; }
  tr.review td { background:var(--warn); }
  tr.review td:first-child { box-shadow: inset -3px 0 0 var(--warn-line); }
  .tag { font-size:11px; padding:2px 7px; border-radius:20px; background:var(--warn-line); color:#000; white-space:nowrap; }
  .tag.dup { background:#d9e7ff; }
  .del { color:var(--bad); border:none; background:none; font-size:18px; padding:4px 8px; }
  .total { margin-top:12px; font-weight:700; display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; }
  .hint { font-size:13px; color:var(--muted); margin-top:8px; }
  .toast { position:fixed; bottom:18px; left:50%; transform:translateX(-50%); background:#222; color:#fff;
           padding:10px 18px; border-radius:10px; opacity:0; transition:.25s; pointer-events:none; }
  .toast.show { opacity:1; }
</style>
</head>
<body>
<div class="wrap">
  <h1>📄 استخراج المدفوعات من الصور</h1>

  <div class="card">
    <div id="drop">اسحب الصور هنا أو <b>اضغط للاختيار</b><br><small>تقدر تختار أكتر من صورة، أو تلصق صورة بـ Ctrl+V</small></div>
    <input id="file" type="file" accept="image/*" multiple hidden>
    <div class="previews" id="previews"></div>
    <div class="status" id="status"></div>
  </div>

  <div class="card" id="results" hidden>
    <div class="toolbar">
      <button class="primary" id="btnCopy">نسخ (للصق في Excel)</button>
      <button id="btnCsv">تحميل CSV</button>
      <button id="btnSend" hidden>إرسال للسيستم</button>
      <span class="spacer"></span>
      <button id="btnAdd">+ صف</button>
      <button id="btnClear">مسح الكل</button>
    </div>
    <div class="table-scroll">
      <table>
        <thead><tr><th>#</th><th>رقم الحساب / المكنة</th><th>المبلغ</th><th>التاريخ والوقت</th><th></th><th></th></tr></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
    <div class="total"><span id="count"></span><span id="sum"></span></div>
    <div class="hint">الصفوف الصفراء محتاجة مراجعة. وعلامة «مكرر؟» معناها نفس الحساب والمبلغ والوقت ظهروا أكتر من مرة (ممكن يكون عادي). راجع الأرقام قبل الإرسال.</div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const CAN_SEND = __CAN_SEND__;
let rows = [];
const $ = id => document.getElementById(id);
const drop = $("drop"), fileInput = $("file");

drop.onclick = () => fileInput.click();
fileInput.onchange = () => handle([...fileInput.files]);
["dragover","dragenter"].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add("over"); }));
["dragleave","drop"].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", ev => handle([...ev.dataTransfer.files]));
document.addEventListener("paste", ev => {
  const files = [...(ev.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
  if (files.length) handle(files);
});

function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2200); }

async function handle(files) {
  files = files.filter(f => f.type.startsWith("image/"));
  if (!files.length) return;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const img = document.createElement("img"); img.src = URL.createObjectURL(f); $("previews").appendChild(img);
    $("status").textContent = `⏳ جاري قراءة الصورة ${i + 1} من ${files.length}... (ممكن تاخد شوية)`;
    const fd = new FormData(); fd.append("image", f);
    try {
      const r = await fetch("/extract", { method: "POST", body: fd });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      rows.push(...data);
      if (!data.length) toast("مفيش صفوف اتقرت في الصورة " + (i + 1));
    } catch (e) { $("status").textContent = "❌ خطأ: " + e.message; return; }
    render();
  }
  $("status").textContent = `✅ تم. إجمالي الصفوف: ${rows.length}`;
  fileInput.value = "";
}

function dupKeys() {
  const m = {}; rows.forEach(r => { const k = r.account + "|" + r.amount + "|" + r.datetime; m[k] = (m[k] || 0) + 1; });
  return m;
}

function render() {
  $("results").hidden = rows.length === 0;
  $("btnSend").hidden = !CAN_SEND;
  const dups = dupKeys();
  const tb = $("tbody"); tb.innerHTML = "";
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    const isDup = dups[r.account + "|" + r.amount + "|" + r.datetime] > 1;
    if (r.needs_review) tr.className = "review";
    tr.innerHTML = `<td>${i + 1}</td>
      <td><input data-f="account" value="${r.account}" inputmode="numeric"></td>
      <td><input data-f="amount" value="${r.amount}" inputmode="numeric"></td>
      <td><input data-f="datetime" value="${r.datetime}"></td>
      <td>${r.needs_review ? '<span class="tag">راجع</span>' : ''} ${isDup ? '<span class="tag dup">مكرر؟</span>' : ''}</td>
      <td><button class="del" title="حذف">✕</button></td>`;
    tr.querySelectorAll("input").forEach(inp => inp.oninput = () => { r[inp.dataset.f] = inp.value; r.needs_review = false; updateTotals(); });
    tr.querySelector(".del").onclick = () => { rows.splice(i, 1); render(); };
    tb.appendChild(tr);
  });
  updateTotals();
}

function updateTotals() {
  const sum = rows.reduce((s, r) => s + (parseInt(String(r.amount).replace(/\D/g, "")) || 0), 0);
  $("count").textContent = `عدد العمليات: ${rows.length}`;
  $("sum").textContent = `الإجمالي: ${sum.toLocaleString("en-US")}`;
}

$("btnAdd").onclick = () => { rows.push({ account: "", amount: "", datetime: "", needs_review: true }); render(); };
$("btnClear").onclick = () => { if (confirm("مسح كل الصفوف؟")) { rows = []; $("previews").innerHTML = ""; $("status").textContent = ""; render(); } };

$("btnCopy").onclick = async () => {
  const txt = rows.map(r => [r.account, r.amount, r.datetime].join("\t")).join("\n");
  try { await navigator.clipboard.writeText(txt); toast("تم النسخ ✔"); } catch { toast("تعذر النسخ"); }
};

$("btnCsv").onclick = () => {
  const csv = "\ufeffaccount,amount,datetime\n" + rows.map(r => [r.account, r.amount, r.datetime].join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = "payments.csv"; a.click();
};

$("btnSend").onclick = async () => {
  if (!confirm(`إرسال ${rows.length} صف للسيستم؟`)) return;
  const payload = rows.map(({ account, amount, datetime }) => ({ account, amount: Number(amount), datetime }));
  const r = await fetch("/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const d = await r.json();
  toast(d.ok ? "تم الإرسال ✔" : "فشل الإرسال: " + (d.error || ""));
};
</script>
</body>
</html>
"""

if __name__ == "__main__":
    print(f"\nافتح المتصفح على:  http://localhost:{PORT}\n")
    app.run(host="0.0.0.0", port=PORT, debug=False)
