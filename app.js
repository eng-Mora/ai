/* ============================================================
   لوحة تحكم التحصيل - منطق الأدمن
   هيكل Firebase:
     collectors/{id}  : name, code, pin, active, createdAt
     customers/{id}   : name, phone, type(assigned|shared), assignedTo, debt, updatedAt
     collections/{id} : customerId, customerName, collectorId, collectorName,
                        amount, debtSeen, status(synced|approved|rejected),
                        createdAt, syncedAt, reviewedAt, reviewNote, applied
   ============================================================ */

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const state = { customers: {}, collectors: {}, collections: {}, locations: {} };

// ---------- أدوات مساعدة ----------
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString('ar-EG', { maximumFractionDigits: 2 });
const fmtDate = (t) =>
  t ? new Date(t).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' }) : '-';
const entries = (obj) => Object.entries(obj || {}).map(([id, v]) => ({ id, ...v }));

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2800);
}

// ---------- الدخول ----------
function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  startListeners();
}
$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if ($('loginPass').value === ADMIN_PASSWORD) {
    sessionStorage.setItem('admin', '1');
    showApp();
  } else {
    $('loginErr').textContent = 'كلمة السر غير صحيحة';
  }
});
$('logout').addEventListener('click', () => {
  sessionStorage.removeItem('admin');
  location.reload();
});
if (sessionStorage.getItem('admin') === '1') showApp();

// ---------- التبويبات ----------
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.add('hidden'));
  $('tab-' + b.dataset.tab).classList.remove('hidden');
  if (b.dataset.tab === 'map') {
    // الخريطة لا تعرف حجمها وهي مخفية، فنحدّثها عند إظهار التبويب
    setTimeout(() => {
      if (map) map.invalidateSize();
      mapFitted = false;
      renderMap();
    }, 50);
  }
});

// ---------- الاستماع للبيانات ----------
let started = false;
function startListeners() {
  if (started) return;
  started = true;
  setInterval(renderMap, 30000); // لتحديث "آخر ظهور" وحالة الاتصال
  ['customers', 'collectors', 'collections', 'locations'].forEach((key) => {
    db.ref(key).on(
      'value',
      (snap) => {
        state[key] = snap.val() || {};
        renderAll();
      },
      (err) => toast('خطأ في القراءة من Firebase: ' + err.message)
    );
  });
}

function renderAll() {
  renderStats();
  renderReview();
  renderCustomers();
  renderCollectors();
  renderMap();
}

// ---------- الإحصائيات ----------
function renderStats() {
  const customers = entries(state.customers);
  const cols = entries(state.collections);
  const totalDebt = customers.reduce((s, c) => s + Number(c.debt || 0), 0);
  const approved = cols.filter((c) => c.status === 'approved');
  const pending = cols.filter((c) => c.status === 'synced');

  $('stDebt').textContent = num(totalDebt);
  $('stApproved').textContent = num(approved.reduce((s, c) => s + Number(c.amount), 0));
  $('stPendingAmt').textContent = num(pending.reduce((s, c) => s + Number(c.amount), 0));
  $('stCustomers').textContent = num(customers.length);
  $('pendingBadge').textContent = pending.length;
  $('pendingBadge').dataset.n = pending.length;

  const rows = entries(state.collectors).map((col) => {
    const mine = cols.filter((c) => c.collectorId === col.id);
    const sum = (st) => mine.filter((c) => c.status === st).reduce((s, c) => s + Number(c.amount), 0);
    const cnt = (st) => mine.filter((c) => c.status === st).length;
    return `<tr>
      <td>${esc(col.name)}</td>
      <td>${num(sum('approved'))}</td><td>${cnt('approved')}</td>
      <td>${num(sum('synced'))}</td><td>${cnt('synced')}</td>
      <td>${cnt('rejected')}</td></tr>`;
  });
  $('statsBody').innerHTML = rows.join('') || '<tr><td class="empty" colspan="6">لا يوجد محصلون بعد</td></tr>';
}

// ---------- مراجعة التحصيلات ----------
const STATUS_LABEL = { synced: 'بانتظار المراجعة', approved: 'معتمد', rejected: 'مرفوض' };

function reviewNotes(c) {
  const notes = [];
  const cust = state.customers[c.customerId];
  if (!cust) {
    notes.push('العميل غير موجود');
    return notes;
  }
  if (c.status === 'synced') {
    if (Number(c.debtSeen) !== Number(cust.debt)) notes.push('بيانات المحصل قديمة: المديونية تغيّرت');
    if (Number(c.amount) > Number(cust.debt)) notes.push('المبلغ أكبر من المديونية الحالية');
    const others = entries(state.collections).filter(
      (x) => x.id !== c.id && x.customerId === c.customerId && x.status === 'synced'
    );
    if (others.length) notes.push(`يوجد ${others.length} تحصيل آخر معلق لنفس العميل`);
  }
  if (c.status === 'rejected' && c.reviewNote) notes.push('سبب الرفض: ' + c.reviewNote);
  return notes;
}

function renderReview() {
  const f = $('reviewFilter').value;
  const q = $('reviewSearch').value.trim().toLowerCase();
  let list = entries(state.collections).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (f !== 'all') list = list.filter((c) => c.status === f);
  if (q) list = list.filter((c) => (c.customerName + ' ' + c.collectorName).toLowerCase().includes(q));

  $('reviewBody').innerHTML =
    list
      .map((c) => {
        const cust = state.customers[c.customerId];
        const notes = reviewNotes(c).map((n) => `<span class="note-warn">${esc(n)}</span>`).join('');
        const actions =
          c.status === 'synced'
            ? `<button class="btn small ok" data-act="approve" data-id="${esc(c.id)}">موافقة</button>
               <button class="btn small bad" data-act="reject" data-id="${esc(c.id)}">رفض</button>`
            : '';
        return `<tr>
          <td>${fmtDate(c.createdAt)}</td>
          <td>${esc(c.customerName)}</td>
          <td>${esc(c.collectorName)}</td>
          <td><b>${num(c.amount)}</b></td>
          <td>${num(c.debtSeen)}</td>
          <td>${cust ? num(cust.debt) : '-'}</td>
          <td class="notes">${notes || '-'}</td>
          <td>${
            typeof c.lat === 'number' && typeof c.lng === 'number'
              ? `<a class="loc" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${c.lat},${c.lng}">عرض الموقع</a>`
              : '-'
          }</td>
          <td><span class="tag ${esc(c.status)}">${esc(STATUS_LABEL[c.status] || c.status)}</span></td>
          <td>${actions}</td></tr>`;
      })
      .join('') || '<tr><td class="empty" colspan="10">لا توجد تحصيلات</td></tr>';
}
$('reviewFilter').addEventListener('change', renderReview);
$('reviewSearch').addEventListener('input', renderReview);

$('reviewBody').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'approve') approveCollection(b.dataset.id, b);
  if (b.dataset.act === 'reject') rejectCollection(b.dataset.id, b);
});

/**
 * الموافقة على تحصيل:
 * 1) "حجز" التحصيل بـ Transaction (synced -> approving) لمنع الخصم المزدوج
 *    حتى لو ضغط أدمنان الزر في نفس اللحظة.
 * 2) خصم المبلغ من مديونية العميل بـ Transaction.
 * 3) تثبيت الحالة approved وتسجيل المديونية بعد الخصم.
 */
async function approveCollection(id, btn) {
  const c = state.collections[id];
  const cust = c && state.customers[c.customerId];
  if (!c || !cust) return toast('العميل أو التحصيل غير موجود');

  const amount = Number(c.amount);
  if (amount > Number(cust.debt)) {
    if (!confirm('المبلغ أكبر من المديونية الحالية، وسيصبح رصيد العميل بالسالب. هل تريد المتابعة؟')) return;
  }
  document.querySelectorAll('#reviewBody button').forEach((x) => (x.disabled = true));

  try {
    const claim = await db.ref('collections/' + id).transaction((cur) => {
      if (cur && cur.status === 'synced') {
        cur.status = 'approving';
        return cur;
      }
      return; // إلغاء: تمت معالجته من قبل
    });
    if (!claim.committed) return toast('تمت معالجة هذا التحصيل من قبل');

    const debtRes = await db.ref('customers/' + c.customerId + '/debt').transaction((d) => Number(d || 0) - amount);
    await db.ref('customers/' + c.customerId + '/updatedAt').set(firebase.database.ServerValue.TIMESTAMP);

    await db.ref('collections/' + id).update({
      status: 'approved',
      applied: true,
      debtAfter: debtRes.snapshot.val(),
      reviewedAt: firebase.database.ServerValue.TIMESTAMP,
    });
    toast('تمت الموافقة وخصم المبلغ من المديونية');
  } catch (err) {
    toast('فشلت العملية: ' + err.message);
  } finally {
    renderReview();
  }
}

async function rejectCollection(id) {
  const note = prompt('سبب الرفض (اختياري):');
  if (note === null) return;
  try {
    const res = await db.ref('collections/' + id).transaction((cur) => {
      if (cur && cur.status === 'synced') {
        cur.status = 'rejected';
        cur.reviewNote = note;
        cur.reviewedAt = Date.now();
        return cur;
      }
      return;
    });
    toast(res.committed ? 'تم رفض التحصيل' : 'تمت معالجة هذا التحصيل من قبل');
  } catch (err) {
    toast('فشلت العملية: ' + err.message);
  }
}

// ---------- العملاء ----------
function collectorName(id) {
  return state.collectors[id] ? state.collectors[id].name : '-';
}

function renderCustomers() {
  const q = $('custSearch').value.trim().toLowerCase();
  const tf = $('custTypeFilter').value;
  let list = entries(state.customers).sort((a, b) => String(a.name).localeCompare(String(b.name), 'ar'));
  if (tf !== 'all') list = list.filter((c) => c.type === tf);
  if (q) list = list.filter((c) => (c.name + ' ' + (c.phone || '')).toLowerCase().includes(q));

  $('custBody').innerHTML =
    list
      .map(
        (c) => `<tr>
        <td>${esc(c.name)}</td>
        <td>${esc(c.phone || '-')}</td>
        <td><span class="tag ${esc(c.type)}">${c.type === 'shared' ? 'مشترك' : 'مخصص'}</span></td>
        <td>${c.type === 'assigned' ? esc(collectorName(c.assignedTo)) : '-'}</td>
        <td><b>${num(c.debt)}</b></td>
        <td>${typeof c.lat === 'number' && typeof c.lng === 'number'
          ? `<a class="loc" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${c.lat},${c.lng}">محدد ✓</a>`
          : '<span class="muted">غير محدد</span>'}</td>
        <td>
          <button class="btn small" data-act="edit" data-id="${esc(c.id)}">تعديل</button>
          <button class="btn small bad" data-act="del" data-id="${esc(c.id)}">حذف</button>
        </td></tr>`
      )
      .join('') || '<tr><td class="empty" colspan="7">لا يوجد عملاء. أضف عميلًا أو استورد ملف CSV.</td></tr>';
}
$('custSearch').addEventListener('input', renderCustomers);
$('custTypeFilter').addEventListener('change', renderCustomers);

$('custBody').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'edit') openCustomerForm(b.dataset.id);
  if (b.dataset.act === 'del') deleteCustomer(b.dataset.id);
});
$('addCustomer').addEventListener('click', () => openCustomerForm());
$('importCustomers').addEventListener('click', openImportForm);

function collectorOptions(selected) {
  return (
    '<option value="">— اختر المحصل —</option>' +
    entries(state.collectors)
      .map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`)
      .join('')
  );
}

function openCustomerForm(id) {
  const c = id ? state.customers[id] : { type: 'assigned', debt: 0 };
  openModal(
    id ? 'تعديل عميل' : 'عميل جديد',
    `<div class="field"><label>الاسم</label><input id="fName" value="${esc(c.name || '')}"></div>
     <div class="field"><label>الهاتف</label><input id="fPhone" value="${esc(c.phone || '')}"></div>
     <div class="field"><label>النوع</label>
       <select id="fType">
         <option value="assigned" ${c.type === 'assigned' ? 'selected' : ''}>مخصص لمحصل</option>
         <option value="shared" ${c.type === 'shared' ? 'selected' : ''}>مشترك</option>
       </select></div>
     <div class="field" id="fAssignWrap"><label>المحصل المخصص</label>
       <select id="fAssigned">${collectorOptions(c.assignedTo)}</select></div>
     <div class="field"><label>المديونية</label><input id="fDebt" type="number" step="0.01" value="${Number(c.debt || 0)}"></div>
     <div class="field"><label>موقع العميل — اضغط على الخريطة أو اسحب الدبوس</label>
       <div id="pickMap" class="pick-map"></div></div>
     <div class="field"><label>أو الصق إحداثيات / رابط Google Maps الطويل (اختياري)</label>
       <input id="fPaste" dir="ltr" placeholder="30.0444, 31.2357"></div>
     <div class="row2">
       <input id="fLat" dir="ltr" placeholder="خط العرض" value="${typeof c.lat === 'number' ? c.lat : ''}">
       <input id="fLng" dir="ltr" placeholder="خط الطول" value="${typeof c.lng === 'number' ? c.lng : ''}">
       <button class="btn small" id="clearLoc" type="button">مسح</button>
     </div>`,
    async () => {
      const name = $('fName').value.trim();
      const type = $('fType').value;
      const assignedTo = $('fAssigned').value;
      const debt = parseFloat($('fDebt').value);
      if (!name) return toast('أدخل اسم العميل');
      if (isNaN(debt)) return toast('المديونية غير صحيحة');
      if (type === 'assigned' && !assignedTo) return toast('اختر المحصل المخصص');
      let lat = null;
      let lng = null;
      const latS = $('fLat').value.trim();
      const lngS = $('fLng').value.trim();
      if (latS || lngS) {
        lat = parseFloat(latS);
        lng = parseFloat(lngS);
        if (isNaN(lat) || isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
          return toast('إحداثيات الموقع غير صحيحة');
        }
      }
      const data = {
        name,
        phone: $('fPhone').value.trim(),
        type,
        assignedTo: type === 'assigned' ? assignedTo : null,
        debt,
        lat,
        lng,
        updatedAt: firebase.database.ServerValue.TIMESTAMP,
      };
      if (id) await db.ref('customers/' + id).update(data);
      else await db.ref('customers').push(data);
      closeModal();
      toast('تم الحفظ');
    }
  );
  const toggle = () => ($('fAssignWrap').style.display = $('fType').value === 'assigned' ? '' : 'none');
  $('fType').addEventListener('change', toggle);
  toggle();
  initPicker(c.lat, c.lng);
}

async function deleteCustomer(id) {
  const hasPending = entries(state.collections).some((c) => c.customerId === id && c.status === 'synced');
  const msg = hasPending
    ? 'يوجد تحصيلات معلقة لهذا العميل. هل تريد حذفه رغم ذلك؟'
    : 'هل تريد حذف هذا العميل؟';
  if (!confirm(msg)) return;
  await db.ref('customers/' + id).remove();
  toast('تم الحذف');
}

// استيراد CSV: الأعمدة: الاسم, الهاتف, النوع(assigned/shared أو مخصص/مشترك), كود المحصل, المديونية
function openImportForm() {
  openModal(
    'استيراد عملاء',
    `<p class="muted" style="margin-top:0">الصق البيانات، سطر لكل عميل، الأعمدة مفصولة بفاصلة:<br>
     <b>الاسم, الهاتف, النوع, كود المحصل, المديونية, خط العرض, خط الطول</b><br>
     (خط العرض والطول اختياريان)<br>
     النوع: assigned أو shared (أو مخصص / مشترك). كود المحصل مطلوب فقط للمخصص.</p>
     <div class="field"><textarea id="fCsv" rows="9" placeholder="أحمد علي, 01012345678, assigned, c01, 1500&#10;محمود حسن, , shared, , 800"></textarea></div>`,
    async () => {
      const lines = $('fCsv').value.split('\n').map((l) => l.trim()).filter(Boolean);
      const byCode = {};
      entries(state.collectors).forEach((c) => (byCode[String(c.code).toLowerCase()] = c.id));
      const updates = {};
      const errors = [];
      lines.forEach((line, i) => {
        const p = line.split(',').map((x) => x.trim());
        if (i === 0 && /الاسم|name/i.test(p[0])) return; // صف العناوين
        const [name, phone, typeRaw, code, debtRaw, latRaw, lngRaw] = p;
        const la = parseFloat(latRaw);
        const ln = parseFloat(lngRaw);
        const hasLoc = !isNaN(la) && !isNaN(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180;
        const type = /shared|مشترك/i.test(typeRaw || '') ? 'shared' : 'assigned';
        const debt = parseFloat(debtRaw);
        const assignedTo = type === 'assigned' ? byCode[String(code || '').toLowerCase()] : null;
        if (!name || isNaN(debt)) return errors.push(`سطر ${i + 1}: بيانات ناقصة`);
        if (type === 'assigned' && !assignedTo) return errors.push(`سطر ${i + 1}: كود المحصل غير موجود`);
        const key = db.ref('customers').push().key;
        updates['customers/' + key] = {
          name,
          phone: phone || '',
          type,
          assignedTo: assignedTo || null,
          debt,
          lat: hasLoc ? la : null,
          lng: hasLoc ? ln : null,
          updatedAt: Date.now(),
        };
      });
      if (errors.length) return alert('يوجد أخطاء ولم يتم الاستيراد:\n' + errors.slice(0, 10).join('\n'));
      const n = Object.keys(updates).length;
      if (!n) return toast('لا توجد بيانات للاستيراد');
      await db.ref().update(updates);
      closeModal();
      toast(`تم استيراد ${n} عميل`);
    }
  );
}

// ---------- المحصلون ----------
function renderCollectors() {
  $('collBody').innerHTML =
    entries(state.collectors)
      .map(
        (c) => `<tr>
        <td>${esc(c.name)}</td>
        <td>${esc(c.code)}</td>
        <td>${esc(c.pin)}</td>
        <td><span class="tag ${c.active === false ? 'off' : 'approved'}">${c.active === false ? 'موقوف' : 'نشط'}</span></td>
        <td>
          <button class="btn small" data-act="edit" data-id="${esc(c.id)}">تعديل</button>
          <button class="btn small" data-act="toggle" data-id="${esc(c.id)}">${c.active === false ? 'تفعيل' : 'إيقاف'}</button>
        </td></tr>`
      )
      .join('') || '<tr><td class="empty" colspan="5">لا يوجد محصلون. أضف محصلًا أولًا.</td></tr>';
}
$('addCollector').addEventListener('click', () => openCollectorForm());
$('collBody').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'edit') openCollectorForm(b.dataset.id);
  if (b.dataset.act === 'toggle') {
    const c = state.collectors[b.dataset.id];
    await db.ref('collectors/' + b.dataset.id + '/active').set(c.active === false);
  }
});

function openCollectorForm(id) {
  const c = id ? state.collectors[id] : { active: true };
  openModal(
    id ? 'تعديل محصل' : 'محصل جديد',
    `<div class="field"><label>الاسم</label><input id="fcName" value="${esc(c.name || '')}"></div>
     <div class="field"><label>كود الدخول (بالإنجليزية بدون مسافات)</label><input id="fcCode" value="${esc(c.code || '')}"></div>
     <div class="field"><label>PIN (4 أرقام على الأقل)</label><input id="fcPin" value="${esc(c.pin || '')}"></div>`,
    async () => {
      const name = $('fcName').value.trim();
      const code = $('fcCode').value.trim().toLowerCase();
      const pin = $('fcPin').value.trim();
      if (!name || !code) return toast('أدخل الاسم والكود');
      if (!/^\d{4,}$/.test(pin)) return toast('الـ PIN يجب أن يكون 4 أرقام على الأقل');
      const dup = entries(state.collectors).some((x) => x.id !== id && String(x.code).toLowerCase() === code);
      if (dup) return toast('هذا الكود مستخدم لمحصل آخر');
      const data = { name, code, pin, active: c.active !== false };
      if (id) await db.ref('collectors/' + id).update(data);
      else await db.ref('collectors').push({ ...data, createdAt: firebase.database.ServerValue.TIMESTAMP });
      closeModal();
      toast('تم الحفظ');
    }
  );
}

// ---------- نافذة النموذج ----------
let modalSaveHandler = null;
function openModal(title, bodyHtml, onSave) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHtml;
  modalSaveHandler = onSave;
  $('modal').classList.remove('hidden');
}
function closeModal() {
  if (pickMap) {
    pickMap.remove();
    pickMap = null;
    pickMarker = null;
  }
  $('modal').classList.add('hidden');
  modalSaveHandler = null;
}
$('modalCancel').addEventListener('click', closeModal);
$('modalSave').addEventListener('click', async () => {
  if (!modalSaveHandler) return;
  $('modalSave').disabled = true;
  try {
    await modalSaveHandler();
  } catch (err) {
    toast('خطأ: ' + err.message);
  } finally {
    $('modalSave').disabled = false;
  }
});

// ---------- الخريطة (مواقع المحصلين) ----------
// locations/{collectorId}: name, lat, lng, accuracy, active, updatedAt
let map = null;
let mapFitted = false;
const markers = {};
const ONLINE_MS = 3 * 60 * 1000; // التطبيق يرسل نبضة كل دقيقة

const isOnline = (l) => !!(l && l.active && Date.now() - Number(l.updatedAt || 0) < ONLINE_MS);

function ago(t) {
  const m = Math.round(Math.max(0, Date.now() - t) / 60000);
  if (m < 1) return 'منذ لحظات';
  if (m < 60) return `منذ ${m} دقيقة`;
  const h = Math.round(m / 60);
  if (h < 24) return `منذ ${h} ساعة`;
  return fmtDate(t);
}

function initMap() {
  if (map || typeof L === 'undefined') return;
  map = L.map('map').setView([30.0444, 31.2357], 11);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);
}

function renderMap() {
  initMap();
  const locs = {};
  entries(state.locations).forEach((l) => (locs[l.id] = l));

  // جدول المحصلين
  $('mapBody').innerHTML =
    entries(state.collectors)
      .map((col) => {
        const l = locs[col.id];
        const has = l && typeof l.lat === 'number';
        const on = isOnline(l);
        return `<tr>
          <td>${esc(col.name)}</td>
          <td><span class="tag ${on ? 'online' : 'offline'}">${on ? 'متصل' : 'غير متصل'}</span></td>
          <td>${has ? ago(Number(l.updatedAt)) : 'لم يشارك موقعه بعد'}</td>
          <td>${has ? `<button class="btn small" data-focus="${esc(col.id)}">عرض على الخريطة</button>` : ''}</td>
        </tr>`;
      })
      .join('') || '<tr><td class="empty" colspan="4">لا يوجد محصلون</td></tr>';

  if (!map) return;

  // علامات الخريطة
  Object.keys(markers).forEach((id) => {
    if (!locs[id]) {
      map.removeLayer(markers[id]);
      delete markers[id];
    }
  });
  const pts = [];
  Object.values(locs).forEach((l) => {
    if (typeof l.lat !== 'number' || typeof l.lng !== 'number') return;
    const name = (state.collectors[l.id] && state.collectors[l.id].name) || l.name || '';
    const on = isOnline(l);
    let m = markers[l.id];
    if (!m) {
      m = L.circleMarker([l.lat, l.lng], { radius: 10, weight: 3, color: '#fff', fillOpacity: 1 }).addTo(map);
      markers[l.id] = m;
    }
    m.setLatLng([l.lat, l.lng]);
    m.setStyle({ fillColor: on ? '#15803d' : '#6b7280' });
    m.unbindTooltip().bindTooltip(esc(name), { permanent: true, direction: 'top', offset: [0, -8] });
    m.unbindPopup().bindPopup(
      `<b>${esc(name)}</b><br>${on ? 'متصل' : 'غير متصل'} — ${ago(Number(l.updatedAt))}` +
        (l.accuracy ? `<br>الدقة: ${Math.round(l.accuracy)} متر` : '')
    );
    pts.push([l.lat, l.lng]);
  });
  if (!mapFitted && pts.length && $('tab-map') && !$('tab-map').classList.contains('hidden')) {
    map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
    mapFitted = true;
  }
}

$('mapBody').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-focus]');
  if (!b || !map) return;
  const m = markers[b.dataset.focus];
  if (!m) return;
  map.flyTo(m.getLatLng(), 16);
  m.openPopup();
  $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// ---------- اختيار موقع العميل (خريطة داخل نافذة العميل) ----------
let pickMap = null;
let pickMarker = null;

// يقبل: "30.04, 31.23" أو رابط Google Maps طويل (@lat,lng أو q=lat,lng أو !3d..!4d..)
function parseCoords(text) {
  const s = String(text || '');
  const m =
    s.match(/@(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/) ||
    s.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/) ||
    s.match(/[?&](?:q|ll|query)=(-?\d+\.?\d*)(?:,|%2C)\s*(-?\d+\.?\d*)/) ||
    s.match(/^\s*(-?\d+\.?\d*)\s*[,،\s]\s*(-?\d+\.?\d*)\s*$/);
  if (!m) return null;
  const la = parseFloat(m[1]);
  const ln = parseFloat(m[2]);
  if (isNaN(la) || isNaN(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  return [la, ln];
}

function defaultPickCenter() {
  const withLoc = entries(state.customers).find((c) => typeof c.lat === 'number' && typeof c.lng === 'number');
  if (withLoc) return [withLoc.lat, withLoc.lng];
  return [30.0444, 31.2357]; // القاهرة
}

function initPicker(lat, lng) {
  if (typeof L === 'undefined') return; // Leaflet لم يتحمل (لا يوجد إنترنت)
  if (pickMap) {
    pickMap.remove();
    pickMap = null;
    pickMarker = null;
  }
  const has = typeof lat === 'number' && typeof lng === 'number';
  pickMap = L.map('pickMap').setView(has ? [lat, lng] : defaultPickCenter(), has ? 16 : 11);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(pickMap);

  const setInputs = (la, ln) => {
    $('fLat').value = Number(la).toFixed(6);
    $('fLng').value = Number(ln).toFixed(6);
  };
  const setPoint = (la, ln, fly) => {
    setInputs(la, ln);
    if (!pickMarker) {
      pickMarker = L.marker([la, ln], { draggable: true }).addTo(pickMap);
      pickMarker.on('dragend', () => {
        const p = pickMarker.getLatLng();
        setInputs(p.lat, p.lng);
      });
    } else {
      pickMarker.setLatLng([la, ln]);
    }
    if (fly) pickMap.setView([la, ln], Math.max(pickMap.getZoom(), 16));
  };

  pickMap.on('click', (e) => setPoint(e.latlng.lat, e.latlng.lng));
  if (has) setPoint(lat, lng);

  // لصق إحداثيات أو رابط
  $('fPaste').addEventListener('input', () => {
    const p = parseCoords($('fPaste').value);
    if (p) setPoint(p[0], p[1], true);
  });
  // تعديل الإحداثيات يدويًا
  const fromInputs = () => {
    const la = parseFloat($('fLat').value);
    const ln = parseFloat($('fLng').value);
    if (!isNaN(la) && !isNaN(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180) setPoint(la, ln, true);
  };
  $('fLat').addEventListener('change', fromInputs);
  $('fLng').addEventListener('change', fromInputs);
  // مسح الموقع
  $('clearLoc').addEventListener('click', () => {
    $('fLat').value = '';
    $('fLng').value = '';
    $('fPaste').value = '';
    if (pickMarker) {
      pickMap.removeLayer(pickMarker);
      pickMarker = null;
    }
  });

  setTimeout(() => pickMap && pickMap.invalidateSize(), 100);
}
