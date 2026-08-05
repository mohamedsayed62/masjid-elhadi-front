(function () {
    'use strict';

    // =====================================================================
    // CONFIG
    // =====================================================================
    const CONFIG = {
        API_BASE_URL: 'https://masjid-nodejs-production.up.railway.app/api',
        STUDENTS_ENDPOINT:          (userId) => `/students/${userId}`,
        ATTENDANCE_ENDPOINT:        ()       => `/attendance`,
        ATTENDANCE_BY_DAY_ENDPOINT: ()       => `/attendance/get-attendance`,
        // GET /users/admin/getUsers — requires Authorization: Bearer <token>
        ADMIN_USERS_ENDPOINT: '/users/admin/getUsers',
    };

    // LocalStorage keys — must match whatever the login screens write.
    const ACTIVE_USER_ID_KEY = 'active_user_id';
    const ADMIN_TOKEN_KEY    = 'admin_token';   // set by admin login; absent for regular محفظ

    // =====================================================================
    // DOM refs
    // =====================================================================
    const mainContent    = document.getElementById('mainContent');
    const headerSubtitle = document.getElementById('headerSubtitle');
    const sideName       = document.getElementById('sideName');

    const confirmModal  = document.getElementById('confirmModal');
    const confirmIcon   = document.getElementById('confirmIcon');
    const confirmTitle  = document.getElementById('confirmTitle');
    const confirmMsg    = document.getElementById('confirmMsg');
    const cancelConfirm = document.getElementById('cancelConfirm');
    const okConfirm     = document.getElementById('okConfirm');

    const toast = document.getElementById('toast');

    // =====================================================================
    // State
    // =====================================================================
    let adminUsers     = [];   // list of محفظين — only populated in admin mode
    let viewingUserId  = null; // the محفظ currently selected by the admin

    let students           = [];
    let selectedDate       = '';
    let sessionName        = '';
    let records            = {};   // { [studentId]: 'present' | 'absent' | 'late' | 'excused' }
    let existingDayRecords = {};
    let confirmCallback    = null;
    let isLoadingStudents  = false;
    let isSaving           = false;

    // =====================================================================
    // Auth / mode helpers
    // =====================================================================
    function getActiveUserId() {
        return localStorage.getItem(ACTIVE_USER_ID_KEY);
    }

    function getAdminToken() {
        return localStorage.getItem(ADMIN_TOKEN_KEY);
    }

    /** True when an admin JWT is present in localStorage. */
    function isAdminMode() {
        return !!getAdminToken();
    }

    /**
     * The userId whose students we should actually be fetching:
     *   - admin has selected a محفظ  → that محفظ's id
     *   - regular محفظ (or admin hasn't chosen yet) → device's own active_user_id
     */
    function getEffectiveUserId() {
        return viewingUserId || getActiveUserId();
    }

    // =====================================================================
    // API layer
    // =====================================================================
    async function apiRequest(path, options = {}) {
        const { headers: extraHeaders, ...restOptions } = options;
        const res = await fetch(CONFIG.API_BASE_URL + path, {
            headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
            ...restOptions,
        });

        let body = null;
        try { body = await res.json(); } catch (_) { /* no body */ }

        if (!res.ok || (body && body.status && body.status !== 'success')) {
            throw new Error((body && body.message) || `فشل الطلب (${res.status})`);
        }
        return body;
    }

    function fetchStudents(userId) {
        return apiRequest(CONFIG.STUDENTS_ENDPOINT(userId), { method: 'GET' })
            .then(body => body.data || []);
    }

    /**
     * FIX #4: sessionNameVal added so the session name captured from the UI
     * is actually included in the request body instead of being silently dropped.
     */
    function postAttendance(studentId, day, attend, sessionNameVal) {
        return apiRequest(CONFIG.ATTENDANCE_ENDPOINT(), {
            method: 'POST',
            body: JSON.stringify({
                student_id: studentId,
                day,
                attend,
                ...(sessionNameVal ? { session_name: sessionNameVal } : {}),
            }),
        });
    }

    /**
     * POST /get-attendance { userId, day }
     * Returns a map: { [studentId]: status } — empty map if nothing recorded yet.
     */
    async function fetchAttendanceForDay(userId, day) {
        try {
            const body = await apiRequest(CONFIG.ATTENDANCE_BY_DAY_ENDPOINT(), {
                method: 'POST',
                body: JSON.stringify({ userId, day }),
            });
            const list = (body && body.data) || [];
            const map  = {};
            list.forEach(rec => { map[String(rec.student_id)] = rec.attend; });
            return map;
        } catch (_) {
            // "لا يوجد حضور" / "لا يوجد طلبة" → nothing recorded yet, not an error.
            return {};
        }
    }

    /**
     * GET /users/admin/getUsers — requires admin Bearer token.
     * Returns the list of محفظين (wallet holders / mentors).
     */
    async function fetchAdminUsers() {
        const token = getAdminToken();
        const body  = await apiRequest(CONFIG.ADMIN_USERS_ENDPOINT, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
        });
        let reportsLinkBtn = document.querySelectorAll('.reports-btn');
        reportsLinkBtn.forEach(e => {
            e.href = 'reports-admin.html';
        })
        return Array.isArray(body.data) ? body.data : [];
    }

    /** FIX #4: pass sessionName so it reaches postAttendance. */
    async function saveAllRecords(userId, day) {
        const entries = Object.entries(records);
        const results = await Promise.allSettled(
            entries.map(([studentId, status]) =>
                postAttendance(studentId, day, status, sessionName)
            )
        );
        const failed = results.filter(r => r.status === 'rejected');
        return { total: entries.length, failed: failed.length };
    }

    // =====================================================================
    // Admin panel — injected as a sibling BEFORE mainContent so it persists
    // across every mainContent re-render.
    // =====================================================================
    let adminPanelEl = null;

    function injectAdminPanel() {
        if (!isAdminMode() || adminPanelEl) return;

        adminPanelEl = document.createElement('div');
        adminPanelEl.id        = 'adminPanel';
        adminPanelEl.className = 'w-full max-w-4xl mx-auto px-4 md:px-8 pt-4';
        mainContent.parentNode.insertBefore(adminPanelEl, mainContent);

        paintAdminPanel();
    }

    /** Repaints the chip list; called after adminUsers loads or viewingUserId changes. */
    function paintAdminPanel() {
        if (!adminPanelEl) return;

        const owner = viewingUserId
            ? adminUsers.find(u => u._id === viewingUserId)
            : null;

        adminPanelEl.innerHTML = `
            <div class="bg-primary rounded-2xl p-4 shadow-sm mb-3 fade-in">
                <div class="flex items-center gap-2 mb-3">
                    <span class="material-symbols-outlined text-secondary">admin_panel_settings</span>
                    <h4 class="text-white font-bold text-sm">لوحة الإدارة</h4>
                    ${owner
                        ? `<span class="mr-auto bg-secondary text-primary text-xs font-bold px-3 py-1 rounded-full">
                               ${escapeHtml(owner.name)}
                           </span>`
                        : `<span class="mr-auto text-white/50 text-xs">اختر محفظاً</span>`
                    }
                </div>
                <div class="flex gap-2 overflow-x-auto pb-1" id="adminUsersList">
                    ${adminUsers.length
                        ? adminUsers.map(u => `
                            <button type="button"
                                class="admin-user-chip flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-bold border transition-colors
                                       ${viewingUserId === u._id
                                           ? 'bg-secondary text-primary border-secondary'
                                           : 'bg-white/10 text-white border-white/20 hover:bg-white/20'}"
                                data-id="${escapeHtml(u._id)}">
                                ${escapeHtml(u.name)}
                            </button>`).join('')
                        : `<span class="text-white/40 text-sm">لا يوجد محفظون</span>`
                    }
                </div>
            </div>
        `;

        document.getElementById('adminUsersList')?.addEventListener('click', e => {
            const chip = e.target.closest('.admin-user-chip');
            if (!chip) return;

            viewingUserId = chip.dataset.id;

            // Reset per-محفظ state when the admin switches to another one.
            students           = [];
            records            = {};
            existingDayRecords = {};
            selectedDate       = '';
            sessionName        = '';

            paintAdminPanel();
            render();
        });
    }

    async function initAdminPanel() {
        if (!isAdminMode()) return;

        injectAdminPanel();         // create the DOM node immediately (shows "اختر محفظاً")

        try {
            adminUsers = await fetchAdminUsers();
            paintAdminPanel();      // repaint with the real chip list
        } catch (err) {
            showToast(err.message || 'تعذر تحميل قائمة المحفظين', 'error');
        }
    }

    // =====================================================================
    // Helpers
    // =====================================================================
    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function getInitials(name) {
        const parts = (name || '').trim().split(/\s+/);
        if (parts.length >= 2) return parts[0][0] + parts[1][0];
        return parts[0]?.[0] || '?';
    }

    function getTodayISO() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    function getYesterdayISO() { return getDaysAgo(1); }
    function getDaysAgo(n) {
        const d = new Date();
        d.setDate(d.getDate() - n);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function formatArabicDate(isoDate) {
        if (!isoDate) return '';
        const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
        const days   = ['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
        const d = new Date(isoDate + 'T00:00:00');
        if (isNaN(d.getTime())) return isoDate;
        return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
    }

    function showToast(message, type) {
        toast.textContent = message;
        toast.className   = 'toast show' + (type ? ' ' + type : '');
        setTimeout(() => toast.classList.remove('show'), 2800);
    }

    function computeStats() {
        let present = 0, absent = 0, excused = 0, late = 0, unmarked = 0;
        students.forEach(s => {
            const st = records[String(s._id || s.id)];
            if      (st === 'present') present++;
            else if (st === 'absent')  absent++;
            else if (st === 'excused') excused++;
            else if (st === 'late')    late++;
            else                       unmarked++;
        });
        const marked = present + absent + excused + late;
        const pct    = marked > 0 ? Math.round(((present + late) / marked) * 100) : 0;
        return { present, absent, excused, late, unmarked, marked, total: students.length, pct };
    }

    /**
     * FIX #5: Key-order-safe records comparison.
     * JSON.stringify({ a:1, b:2 }) !== JSON.stringify({ b:2, a:1 }) would
     * cause false "unsaved changes" warnings after loading from the API.
     */
    function recordsEqual(a, b) {
        const aKeys = Object.keys(a);
        const bKeys = Object.keys(b);
        if (aKeys.length !== bKeys.length) return false;
        return aKeys.every(k => a[k] === b[k]);
    }

    // =====================================================================
    // Data loading
    // =====================================================================
    async function loadRecordsForDate(date) {
        const userId       = getEffectiveUserId();
        existingDayRecords = await fetchAttendanceForDay(userId, date);
        records            = { ...existingDayRecords };
    }

    // =====================================================================
    // Main render entry point
    // =====================================================================
    async function render() {
        const userId = getEffectiveUserId();

        if (!userId) {
            headerSubtitle.textContent = isAdminMode() ? 'اختر محفظاً' : 'غير مسجل';
            sideName.textContent       = isAdminMode() ? 'لوحة الإدارة' : '—';
            isAdminMode() ? renderSelectMentor() : renderNoUser();
            return;
        }

        // While an admin is viewing a specific محفظ, show their name in the sidebar.
        if (isAdminMode() && viewingUserId) {
            const owner = adminUsers.find(u => u._id === viewingUserId);
            if (owner) sideName.textContent = owner.name;
        }

        renderLoading();
        isLoadingStudents = true;

        try {
            students = await fetchStudents(userId);
        } catch (err) {
            isLoadingStudents = false;
            renderError(err.message);
            return;
        }
        isLoadingStudents = false;

        headerSubtitle.textContent = `الطلبة: ${students.length}`;

        if (students.length === 0) {
            renderNoStudents();
            return;
        }

        selectedDate = selectedDate || getTodayISO();
        await loadRecordsForDate(selectedDate);
        renderPage();
    }

    // =====================================================================
    // Render: main attendance page
    // FIX #3: save and restore #studentsList scroll position so that clicking
    // a student's status button doesn't jump the list back to the top.
    // =====================================================================
    function renderPage() {
        // Save scroll position BEFORE replacing innerHTML
        const listEl         = document.getElementById('studentsList');
        const savedScrollTop = listEl ? listEl.scrollTop : 0;

        const stats       = computeStats();
        const hasExisting = Object.keys(existingDayRecords).length > 0;
        const isFuture    = selectedDate > getTodayISO();

        mainContent.innerHTML = `
            <section class="mb-5 fade-in">
                <div class="flex items-center justify-between mb-3">
                    <div>
                        <h2 class="text-headline-lg text-primary font-bold flex items-center gap-2">
                            <span class="material-symbols-outlined text-secondary">event_available</span>
                            ${hasExisting ? 'تعديل الحضور' : 'تسجيل الحضور'}
                        </h2>
                        <p class="text-body-md text-on-surface-variant mt-1">
                            ${hasExisting ? 'يوجد سجل مسبق لهذا التاريخ' : 'اختر التاريخ وسجّل حضور الطلبة'}
                        </p>
                    </div>
                    <button onclick="location.href='students.html'"
                        class="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center shadow-sm hover:bg-surface-container-low transition-colors">
                        <span class="material-symbols-outlined text-on-surface-variant">close</span>
                    </button>
                </div>
            </section>

            ${hasExisting ? `
            <section class="editing-banner rounded-2xl p-4 mb-4 flex items-center gap-3 shadow-sm fade-in" style="animation-delay:.02s">
                <div class="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
                    <span class="material-symbols-outlined text-white">edit</span>
                </div>
                <div class="flex-1">
                    <h4 class="text-white font-bold text-sm">وضع التعديل</h4>
                    <p class="text-white/80 text-xs mt-0.5">تم العثور على سجل سابق بتاريخ ${formatArabicDate(selectedDate)}</p>
                </div>
                <span class="bg-white/20 text-white text-xs font-bold px-2 py-1 rounded-full">${stats.marked} مسجَّل</span>
            </section>` : ''}

            <section class="bg-surface-container rounded-2xl p-5 shadow-sm mb-4 fade-in" style="animation-delay:.05s">
                <label class="text-label-bold text-on-surface-variant mb-2 block">تاريخ الجلسة</label>
                <input type="date" id="dateInput" class="date-input" value="${selectedDate}" max="${getTodayISO()}"/>
                <div class="flex items-center justify-between mt-3">
                    <p class="text-sm text-primary font-bold" id="dateLabel">${formatArabicDate(selectedDate)}</p>
                </div>
                <div class="flex gap-2 mt-3 overflow-x-auto pb-1">
                    <button class="quick-chip ${selectedDate === getTodayISO()     ? 'active' : ''}" data-date="${getTodayISO()}">اليوم</button>
                    <button class="quick-chip ${selectedDate === getYesterdayISO() ? 'active' : ''}" data-date="${getYesterdayISO()}">أمس</button>
                    <button class="quick-chip ${selectedDate === getDaysAgo(2)     ? 'active' : ''}" data-date="${getDaysAgo(2)}">قبل يومين</button>
                    <button class="quick-chip ${selectedDate === getDaysAgo(3)     ? 'active' : ''}" data-date="${getDaysAgo(3)}">قبل 3 أيام</button>
                    <button class="quick-chip ${selectedDate === getDaysAgo(7)     ? 'active' : ''}" data-date="${getDaysAgo(7)}">قبل أسبوع</button>
                </div>
                ${isFuture ? `
                <div class="mt-3 bg-error/10 border border-error/20 rounded-xl p-3 flex items-start gap-2">
                    <span class="material-symbols-outlined text-error text-lg">warning</span>
                    <p class="text-xs text-error font-semibold">لا يمكن تسجيل حضور لتاريخ في المستقبل</p>
                </div>` : ''}
            </section>

            <section class="bg-surface-container rounded-2xl p-5 shadow-sm mb-4 fade-in" style="animation-delay:.1s">
                <label class="text-label-bold text-on-surface-variant mb-2 block">اسم الجلسة (اختياري)</label>
                <input type="text" id="sessionNameInput" class="date-input"
                    placeholder="مثال: حلقة تحفيظ صباحية" value="${escapeHtml(sessionName)}"/>
            </section>

            <section class="bg-surface-container rounded-2xl p-4 shadow-sm mb-4 fade-in" style="animation-delay:.15s">
                <div class="grid grid-cols-5 gap-2 text-center">
                    <div><div class="text-xl font-bold text-success">${stats.present}</div><div class="text-[10px] text-on-surface-variant font-bold">حاضر</div></div>
                    <div><div class="text-xl font-bold text-error">${stats.absent}</div><div class="text-[10px] text-on-surface-variant font-bold">غائب</div></div>
                    <div><div class="text-xl font-bold text-warning">${stats.late}</div><div class="text-[10px] text-on-surface-variant font-bold">متأخر</div></div>
                    <div><div class="text-xl font-bold text-secondary">${stats.excused}</div><div class="text-[10px] text-on-surface-variant font-bold">بعذر</div></div>
                    <div><div class="text-xl font-bold text-on-surface-variant">${stats.unmarked}</div><div class="text-[10px] text-on-surface-variant font-bold">لم يُسجَّل</div></div>
                </div>
                <div class="mt-3 pt-3 border-t border-outline-variant flex items-center justify-between">
                    <span class="text-xs text-on-surface-variant font-bold">نسبة الحضور</span>
                    <span class="text-sm font-bold ${stats.pct >= 70 ? 'text-success' : stats.pct >= 40 ? 'text-secondary' : 'text-error'}">
                        ${stats.marked > 0 ? stats.pct + '%' : '—'}
                    </span>
                </div>
            </section>

            <section class="bg-surface-container rounded-2xl p-4 shadow-sm mb-4 fade-in" style="animation-delay:.2s">
                <div class="flex items-center justify-between mb-3">
                    <h4 class="text-label-bold text-on-surface-variant font-bold flex items-center gap-1">
                        <span class="material-symbols-outlined text-base">bolt</span>إجراءات سريعة
                    </h4>
                    <span class="text-xs text-on-surface-variant">${students.length} طالب</span>
                </div>
                <div class="grid grid-cols-4 gap-2">
                    <button class="bulk-action-btn status-btn" data-bulk="present"><span class="material-symbols-outlined">check_circle</span>الكل حاضر</button>
                    <button class="bulk-action-btn status-btn" data-bulk="absent"><span class="material-symbols-outlined">cancel</span>الكل غائب</button>
                    <button class="bulk-action-btn status-btn" data-bulk="reset"><span class="material-symbols-outlined">refresh</span>تصفير</button>
                    <button class="bulk-action-btn status-btn" data-bulk="invert"><span class="material-symbols-outlined">swap_horiz</span>عكس</button>
                </div>
            </section>

            <section class="bg-surface-container rounded-2xl shadow-sm mb-4 overflow-hidden fade-in" style="animation-delay:.25s">
                <div class="p-4 border-b border-outline-variant flex items-center justify-between">
                    <h4 class="text-headline-md text-primary font-bold flex items-center gap-2">
                        <span class="material-symbols-outlined text-secondary">group</span>الطلبة
                    </h4>
                    <span class="text-xs bg-primary/10 text-primary px-2 py-1 rounded-full font-bold">${stats.marked}/${students.length}</span>
                </div>
                <div class="divide-y divide-outline-variant max-h-[60vh] overflow-y-auto" id="studentsList">
                    ${renderStudentRows()}
                </div>
            </section>

            <section class="sticky bottom-20 md:bottom-4 z-30 fade-in" style="animation-delay:.3s">
                <button id="saveBtn"
                    class="w-full ${hasExisting ? 'bg-primary' : 'bg-secondary'} text-white py-4 rounded-2xl font-bold shadow-lg active:scale-95 transition-transform flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    ${stats.marked === 0 || isSaving || isFuture ? 'disabled' : ''}>
                    <span class="material-symbols-outlined">${isSaving ? 'hourglass_top' : (hasExisting ? 'save' : 'add_circle')}</span>
                    <span>${isSaving ? 'جارٍ الحفظ...' : (hasExisting ? 'تحديث سجل الحضور' : 'حفظ سجل الحضور')}</span>
                    <span class="bg-white/20 px-2 py-0.5 rounded-full text-xs">${stats.marked}/${students.length}</span>
                </button>
                ${stats.marked === 0 && !isFuture ? `<p class="text-center text-xs text-on-surface-variant mt-2">قم بتسجيل حالة طالب واحد على الأقل</p>` : ''}
            </section>
        `;

        attachEvents();

        // FIX #3: restore the list's scroll position after the DOM is repainted.
        if (savedScrollTop > 0) {
            requestAnimationFrame(() => {
                const newListEl = document.getElementById('studentsList');
                if (newListEl) newListEl.scrollTop = savedScrollTop;
            });
        }
    }

    // =====================================================================
    // Render: student rows
    // =====================================================================
    function renderStudentRows() {
        return students.map((s, idx) => {
            const id       = String(s._id || s.id);
            const st       = records[id] || '';
            const rowClass = st ? `marked-${st}` : '';
            return `
                <div class="student-row ${rowClass} p-4 bg-white" data-student-id="${id}"
                    style="animation:fadeIn 0.3s ease both;animation-delay:${idx * 20}ms">
                    <div class="flex items-center gap-3 mb-3">
                        <div class="w-11 h-11 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                            <span class="text-primary font-bold text-sm">${escapeHtml(getInitials(s.name))}</span>
                        </div>
                        <div class="flex-1 min-w-0">
                            <div class="text-body-md font-bold text-primary truncate">${escapeHtml(s.name)}</div>
                            <div class="flex items-center gap-2 text-xs text-on-surface-variant mt-0.5">
                                ${s.age ? `<span class="truncate flex items-center gap-1">
                                    <span class="material-symbols-outlined text-xs">cake</span>${escapeHtml(String(s.age))} سنة
                                </span>` : ''}
                                ${st
                                    ? `<span class="inline-flex items-center gap-1 font-bold ${getStatusColor(st)}">${getStatusIcon(st)} ${getStatusText(st)}</span>`
                                    : '<span class="text-on-surface-variant/60">لم يُحدد</span>'}
                            </div>
                        </div>
                    </div>
                    <div class="grid grid-cols-4 gap-2">
                        <button class="status-btn ${st === 'present' ? 'active-present' : ''}" data-student="${id}" data-status="present"><span class="material-symbols-outlined">check_circle</span>حاضر</button>
                        <button class="status-btn ${st === 'absent'  ? 'active-absent'  : ''}" data-student="${id}" data-status="absent"><span class="material-symbols-outlined">cancel</span>غائب</button>
                        <button class="status-btn ${st === 'late'    ? 'active-late'    : ''}" data-student="${id}" data-status="late"><span class="material-symbols-outlined">schedule</span>متأخر</button>
                        <button class="status-btn ${st === 'excused' ? 'active-excused' : ''}" data-student="${id}" data-status="excused"><span class="material-symbols-outlined">event_available</span>بعذر</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    function getStatusColor(st) {
        return { present: 'text-success', absent: 'text-error', late: 'text-warning', excused: 'text-secondary' }[st]
            || 'text-on-surface-variant';
    }
    function getStatusIcon(st) {
        const map = { present: 'check_circle', absent: 'cancel', late: 'schedule', excused: 'event_available' };
        return `<span class="material-symbols-outlined text-xs">${map[st] || ''}</span>`;
    }
    function getStatusText(st) {
        return { present: 'حاضر', absent: 'غائب', late: 'متأخر', excused: 'بعذر' }[st] || '';
    }

    // =====================================================================
    // Event wiring (re-run after every renderPage())
    // =====================================================================
    function attachEvents() {
        // Date picker
        const dateInput = document.getElementById('dateInput');
        dateInput.addEventListener('change', e => {
            const newDate = e.target.value;
            if (!newDate) return;
            if (newDate > getTodayISO()) {
                showToast('لا يمكن اختيار تاريخ في المستقبل', 'error');
                dateInput.value = selectedDate;
                return;
            }
            handleDateChange(newDate);
        });

        // Quick chips
        document.querySelectorAll('.quick-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const d = chip.dataset.date;
                if (d > getTodayISO()) { showToast('لا يمكن اختيار تاريخ في المستقبل', 'error'); return; }
                handleDateChange(d);
            });
        });

        // Session name
        document.getElementById('sessionNameInput')?.addEventListener('input', e => {
            sessionName = e.target.value;
        });

        // Per-student status buttons
        document.querySelectorAll('.status-btn[data-student]').forEach(btn => {
            btn.addEventListener('click', () => {
                const sid    = btn.dataset.student;
                const status = btn.dataset.status;
                if (records[sid] === status) delete records[sid];
                else records[sid] = status;
                renderPage();
            });
        });

        // Bulk action buttons
        document.querySelectorAll('.bulk-action-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                switch (btn.dataset.bulk) {
                    case 'present': students.forEach(s => { records[String(s._id || s.id)] = 'present'; }); break;
                    case 'absent':  students.forEach(s => { records[String(s._id || s.id)] = 'absent';  }); break;
                    case 'reset':   records = {}; break;
                    case 'invert':
                        students.forEach(s => {
                            const sid = String(s._id || s.id);
                            if      (records[sid] === 'present') records[sid] = 'absent';
                            else if (records[sid] === 'absent')  records[sid] = 'present';
                        });
                        break;
                }
                renderPage();
            });
        });

        // Save button
        document.getElementById('saveBtn')?.addEventListener('click', handleSaveClick);
    }

    // =====================================================================
    // Date change: warn if unsaved work, then reload records
    // FIX #5: use recordsEqual() instead of JSON.stringify for comparison
    // so that key-ordering differences don't trigger false unsaved-changes warnings.
    // =====================================================================
    async function handleDateChange(newDate) {
        const hasChanges = Object.keys(records).length > 0
            && !recordsEqual(records, existingDayRecords);

        if (hasChanges) {
            openConfirm(
                'تغيير التاريخ',
                'سيتم فقدان التعديلات غير المحفوظة. هل تريد المتابعة؟',
                'warning',
                async () => {
                    selectedDate = newDate;
                    renderLoading();
                    await loadRecordsForDate(selectedDate);
                    renderPage();
                }
            );
        } else {
            selectedDate = newDate;
            renderLoading();
            await loadRecordsForDate(selectedDate);
            renderPage();
        }
    }

    // =====================================================================
    // Save flow
    // =====================================================================
    function handleSaveClick() {
        const stats = computeStats();
        if (stats.marked === 0) { showToast('يرجى تسجيل حالة طالب واحد على الأقل', 'error'); return; }

        if (stats.unmarked > 0) {
            openConfirm(
                'حفظ مع طلبة لم يُسجَّلوا',
                `يوجد ${stats.unmarked} طالب لم يتم تحديد حالتهم. سيتم تجاهلهم. هل تريد المتابعة؟`,
                'warning',
                () => performSave()
            );
        } else {
            performSave();
        }
    }

    async function performSave() {
        isSaving = true;
        renderPage();

        const userId = getEffectiveUserId();

        try {
            const { total, failed } = await saveAllRecords(userId, selectedDate);
            if (failed === 0) {
                // FIX #1 + #2: sync existingDayRecords so the editing banner reflects
                // the saved state and the unsaved-changes check stays accurate.
                existingDayRecords = { ...records };
                showToast('✓ تم حفظ سجل الحضور بنجاح', 'success');
            } else if (failed < total) {
                showToast(`تم الحفظ جزئياً — فشل ${failed} من ${total}`, 'warning');
            } else {
                showToast('فشل حفظ سجل الحضور', 'error');
            }
        } catch (err) {
            showToast(err.message || 'حدث خطأ أثناء الحفظ', 'error');
        } finally {
            isSaving = false;
            // FIX #1: always re-render after save so the UI exits the "جارٍ الحفظ..." state.
            renderPage();
        }
    }

    // =====================================================================
    // Confirm modal
    // =====================================================================
    function openConfirm(title, msg, type, callback) {
        confirmTitle.textContent = title;
        confirmMsg.textContent   = msg;
        confirmCallback          = callback;

        if (type === 'warning') {
            confirmIcon.className = 'w-16 h-16 bg-warning/10 rounded-full flex items-center justify-center mx-auto mb-4';
            confirmIcon.innerHTML = '<span class="material-symbols-outlined text-warning text-3xl">warning</span>';
            okConfirm.className   = 'flex-1 bg-warning text-white py-3 rounded-xl font-bold active:scale-95 transition-transform';
            okConfirm.textContent = 'متابعة';
        } else {
            confirmIcon.className = 'w-16 h-16 bg-secondary/10 rounded-full flex items-center justify-center mx-auto mb-4';
            confirmIcon.innerHTML = '<span class="material-symbols-outlined text-secondary text-3xl">save</span>';
            okConfirm.className   = 'flex-1 bg-secondary text-white py-3 rounded-xl font-bold active:scale-95 transition-transform';
            okConfirm.textContent = 'تأكيد';
        }
        confirmModal.classList.remove('hidden');
        confirmModal.classList.add('flex');
    }

    function closeConfirm() {
        confirmModal.classList.add('hidden');
        confirmModal.classList.remove('flex');
        confirmCallback = null;
    }

    cancelConfirm.addEventListener('click', closeConfirm);
    okConfirm.addEventListener('click', () => { if (confirmCallback) confirmCallback(); closeConfirm(); });
    confirmModal.addEventListener('click', e => { if (e.target === confirmModal) closeConfirm(); });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !confirmModal.classList.contains('hidden')) closeConfirm();
    });

    // =====================================================================
    // Empty / loading / error states
    // =====================================================================
    function renderLoading() {
        mainContent.innerHTML = `
            <section class="flex-1 flex flex-col items-center justify-center py-24 fade-in">
                <div class="spinner mb-4"></div>
                <p class="text-body-md text-on-surface-variant">جارٍ تحميل البيانات...</p>
            </section>`;
    }

    function renderError(message) {
        mainContent.innerHTML = `
            <section class="flex-1 flex items-center justify-center fade-in py-10">
                <div class="bg-surface-container rounded-2xl p-8 shadow-sm text-center max-w-md w-full">
                    <div class="inline-flex items-center justify-center w-24 h-24 rounded-full bg-error/10 mb-4">
                        <span class="material-symbols-outlined text-error text-5xl">cloud_off</span>
                    </div>
                    <h3 class="text-headline-md text-primary font-bold mb-2">تعذّر تحميل البيانات</h3>
                    <p class="text-body-md text-on-surface-variant mb-5">${escapeHtml(message)}</p>
                    <button id="retryBtn" class="bg-secondary text-white px-6 py-3 rounded-xl font-bold shadow-md active:scale-95 transition-transform inline-flex items-center gap-2">
                        <span class="material-symbols-outlined">refresh</span>إعادة المحاولة
                    </button>
                </div>
            </section>`;
        document.getElementById('retryBtn').addEventListener('click', render);
    }

    function renderNoStudents() {
        mainContent.innerHTML = `
            <section class="flex-1 flex items-center justify-center fade-in py-10">
                <div class="bg-surface-container rounded-2xl p-8 shadow-sm text-center max-w-md w-full">
                    <div class="inline-flex items-center justify-center w-24 h-24 rounded-full bg-secondary/10 mb-4">
                        <span class="material-symbols-outlined text-secondary text-5xl">group_off</span>
                    </div>
                    <h3 class="text-headline-md text-primary font-bold mb-2">لا يوجد طلبة</h3>
                    <p class="text-body-md text-on-surface-variant mb-5">يجب إضافة طلبة أولاً قبل تسجيل الحضور</p>
                    <div class="flex gap-3">
                        <button onclick="location.href='dashboard.html'" class="flex-1 bg-surface text-on-surface py-3 rounded-xl font-bold border border-outline-variant active:scale-95 transition-transform">رجوع</button>
                        <button onclick="location.href='students.html'" class="flex-1 bg-secondary text-white py-3 rounded-xl font-bold shadow-md active:scale-95 transition-transform flex items-center justify-center gap-2">
                            <span class="material-symbols-outlined">person_add</span>إضافة طالب
                        </button>
                    </div>
                </div>
            </section>`;
    }

    /**
     * Shown to an admin who hasn't chosen a محفظ yet.
     * Mirrors the selectMentorState in students.js.
     */
    function renderSelectMentor() {
        mainContent.innerHTML = `
            <section class="flex-1 flex items-center justify-center fade-in py-10">
                <div class="bg-surface-container rounded-2xl p-8 shadow-sm text-center max-w-md w-full">
                    <div class="inline-flex items-center justify-center w-24 h-24 rounded-full bg-secondary/10 mb-4">
                        <span class="material-symbols-outlined text-secondary text-5xl">manage_accounts</span>
                    </div>
                    <h3 class="text-headline-md text-primary font-bold mb-2">اختر محفظاً</h3>
                    <p class="text-body-md text-on-surface-variant">اختر محفظاً من الشريط أعلاه لعرض حضور طلبته</p>
                </div>
            </section>`;
    }

    function renderNoUser() {
        headerSubtitle.textContent = 'غير مسجل';
        sideName.textContent       = '—';
        mainContent.innerHTML = `
            <section class="flex-1 flex items-center justify-center fade-in py-10">
                <div class="bg-surface-container rounded-2xl p-8 shadow-sm text-center max-w-md w-full">
                    <div class="inline-flex items-center justify-center w-24 h-24 rounded-full bg-error/10 mb-4">
                        <span class="material-symbols-outlined text-error text-5xl">warning</span>
                    </div>
                    <h3 class="text-headline-md text-primary font-bold mb-2">لا يوجد محفظ نشط</h3>
                    <p class="text-body-md text-on-surface-variant mb-5">يرجى تسجيل الدخول كمحفظ أولاً</p>
                    <button onclick="location.href='index.html'" class="bg-secondary text-white px-6 py-3 rounded-xl font-bold shadow-md active:scale-95 transition-transform inline-flex items-center gap-2">
                        <span class="material-symbols-outlined">login</span>تسجيل الدخول
                    </button>
                </div>
            </section>`;
    }

    // =====================================================================
    // Boot
    // =====================================================================
    initAdminPanel().then(() => render());
})();
