(function () {
    'use strict';

    // =====================================================================
    // CONFIG — adjust these to match your real backend
    // =====================================================================
    const CONFIG = {
        API_BASE_URL: 'https://masjid-nodejs-production.up.railway.app/api',

        // Same pattern as attendance.js
        STUDENTS_ENDPOINT: (userId) => `/students/${userId}`,

        // Fetch every evaluation record for this محفظ's students.
        // Matches: GET /tests/:userId  ->  getTests(req.params.userId)
        EVALUATIONS_ENDPOINT: (userId) => `/tests/${userId}`,

        // Save degrees. Matches: POST /tests  ->  storeTests(req.body: array)
        SAVE_EVALUATION_ENDPOINT: () => `/tests`,

        // Admin-only: list every محفظ/user so an admin can pick whose
        // students to view degrees for. Matches: GET /users/admin/getUsers
        // Requires Authorization: Bearer <admin_token>
        ADMIN_USERS_ENDPOINT: () => `/users/admin/getUsers`,

        // Subjects (المواد) are managed client-side only, per your request.
        SUBJECTS_STORAGE_KEY: 'eval_subjects',

        // GET /tests/:userId only returns an aggregated totalDegree per
        // student — no per-subject breakdown. We cache what YOU enter per
        // subject locally so the modal can still show/prefill it on this
        // device; totalDegree from the server always stays the source of
        // truth for totals/leaderboard/averages.
        DEGREE_CACHE_STORAGE_KEY: 'eval_degree_cache',
    };

    // LocalStorage keys — must match whatever the login screens write.
    const ACTIVE_USER_ID_KEY   = 'active_user_id';
    const ACTIVE_USER_NAME_KEY = 'active_user_name'; // set at login if available; may be absent
    const ADMIN_TOKEN_KEY      = 'admin_token';      // set by admin login; absent for regular محفظ

    // =====================================================================
    // DOM refs
    // =====================================================================
    const mainContent = document.getElementById('mainContent');
    const headerSubtitle = document.getElementById('headerSubtitle');
    const sideName = document.getElementById('sideName');
    const toast = document.getElementById('toast');

    const degreeModal = document.getElementById('degreeModal');
    const modalAvatar = document.getElementById('modalAvatar');
    const modalInitials = document.getElementById('modalInitials');
    const modalStudentName = document.getElementById('modalStudentName');
    const modalStudentMeta = document.getElementById('modalStudentMeta');
    const modalSubjectsList = document.getElementById('modalSubjectsList');
    const modalNoSubjects = document.getElementById('modalNoSubjects');
    const closeModalBtn = document.getElementById('closeModal');
    const saveDegreesBtn = document.getElementById('saveDegreesBtn');
    const saveDegreesBtnText = document.getElementById('saveDegreesBtnText');

    // =====================================================================
    // State
    // =====================================================================
    let currentUserId = localStorage.getItem(ACTIVE_USER_ID_KEY);
    let currentUserName = '';
    let students = [];
    let subjects = [];                 // ['حفظ', 'تجويد', ...]
    let totalsMap = {};                // { studentId: totalDegree } — from the server, source of truth
    let degreeCache = {};              // { studentId: { subjectName: degree } } — local-only, for modal prefill
    let activeStudentId = null;        // student currently open in the modal
    let lastFocusedElement = null;     // to restore focus after modal closes

    // --- grid controls -----------------------------------------------
    let searchQuery = '';
    let sortMode = 'name';             // 'name' | 'avg_desc' | 'avg_asc' | 'unrated'

    // --- admin / user-switching state -----------------------------
    let allUsers = [];                  // list of محفظين returned by the admin endpoint (admin only)
    let viewingUserId = null;           // whose students/degrees are currently shown.
                                         // Regular محفظ: set to currentUserId immediately.
                                         // Admin: stays null until they click a محفظ chip —
                                         // no student data loads before that click.

    let isLoading = false;
    let isGridLoading = false;          // true while switching admin mentor: keeps subjects/toolbar visible
    let isSavingDegrees = false;

    // =====================================================================
    // Auth / mode helpers — same pattern as attendance.js
    // =====================================================================
    function getActiveUserId() {
        return localStorage.getItem(ACTIVE_USER_ID_KEY);
    }

    /** Mentor's display name, if the login flow saved one locally. */
    function getActiveUserName() {
        return localStorage.getItem(ACTIVE_USER_NAME_KEY) || '';
    }

    // Best-effort extraction of a mentor/owner name from a students-endpoint
    // response, so we have a fallback when it isn't cached in localStorage.
    // Checked in order of likelihood; harmless if none match (body.data is
    // normally an array, so body.data.name / body.data.user are just undefined).
    function extractNameFromResponse(body) {
        if (!body) return '';
        const candidates = [
            body.name,
            body.user && body.user.name,
            body.mentor && body.mentor.name,
            body.data && body.data.name,
            body.data && body.data.user && body.data.user.name,
        ];
        const found = candidates.find((v) => typeof v === 'string' && v.trim());
        return found ? found.trim() : '';
    }

    function getAdminToken() {
        return localStorage.getItem(ADMIN_TOKEN_KEY);
    }

    /** True when an admin JWT is present in localStorage. */
    function isAdminMode() {
        return !!getAdminToken();
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
        try { body = await res.json(); } catch (e) { /* no body */ }

        if (!res.ok || (body && body.status && body.status !== 'success')) {
            const message = (body && body.message) || `فشل الطلب (${res.status})`;
            throw new Error(message);
        }
        return body;
    }

    function fetchStudents(userId) {
        return apiRequest(CONFIG.STUDENTS_ENDPOINT(userId), { method: 'GET' })
          .then((body) => ({
              list: (body && body.data) || [],
              name: extractNameFromResponse(body),
          }));
    }

    async function fetchEvaluations(userId) {
        try {
            const body = await apiRequest(CONFIG.EVALUATIONS_ENDPOINT(userId), {
                method: 'GET',
            });
            return (body && body.data) || [];
        } catch (e) {
            // No evaluations recorded yet — treat as empty, not an error
            return [];
        }
    }

    // Backend expects ONE request with an array body:
    // [ { student_id, name, degree }, { student_id, name, degree }, ... ]
    function saveEvaluations(rows) {
        return apiRequest(CONFIG.SAVE_EVALUATION_ENDPOINT(), {
            method: 'POST',
            body: JSON.stringify(rows),
        });
    }

    /**
     * GET /users/admin/getUsers — requires admin Bearer token.
     * Only called when isAdminMode() is true. Returns [] on failure
     * rather than throwing, so a bad/expired token doesn't break the page.
     */
    async function fetchAdminUsers() {
        if (!isAdminMode()) return [];
        const token = getAdminToken();
        try {
            const body = await apiRequest(CONFIG.ADMIN_USERS_ENDPOINT(), {
                method: 'GET',
                headers: { Authorization: `Bearer ${token}` },
            });
            const list = (body && body.data) || [];
            return Array.isArray(list) ? list : [];
        } catch (e) {
            return [];
        }
    }

    // =====================================================================
    // Subjects (localStorage)
    // =====================================================================
    function loadSubjects() {
        try {
            const raw = localStorage.getItem(CONFIG.SUBJECTS_STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    function persistSubjects() {
        localStorage.setItem(CONFIG.SUBJECTS_STORAGE_KEY, JSON.stringify(subjects));
    }

    function addSubject(name) {
        const trimmed = (name || '').trim();
        if (!trimmed) return;
        if (subjects.some((s) => s.toLowerCase() === trimmed.toLowerCase())) {
            showToast('هذه المادة مضافة بالفعل', 'warning');
            return;
        }
        subjects.push(trimmed);
        persistSubjects();
        showToast(`✓ تمت إضافة "${trimmed}"`, 'success');
        renderPage();
    }

    function removeSubject(name) {
        const ok = window.confirm(`إزالة "${name}" من قائمة المواد؟ لن يحذف هذا الدرجات المُسجَّلة مسبقًا لهذه المادة.`);
        if (!ok) return;
        subjects = subjects.filter((s) => s !== name);
        persistSubjects();
        renderPage();
    }

    // =====================================================================
    // Per-subject degree cache (localStorage) — see DEGREE_CACHE_STORAGE_KEY
    // comment above for why this exists.
    // =====================================================================
    function loadDegreeCache() {
        try {
            const raw = localStorage.getItem(CONFIG.DEGREE_CACHE_STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : {};
            return (parsed && typeof parsed === 'object') ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    function persistDegreeCache() {
        localStorage.setItem(CONFIG.DEGREE_CACHE_STORAGE_KEY, JSON.stringify(degreeCache));
    }

    function cacheDegrees(studentId, rows) {
        // rows: [{ subject, degree }, ...]
        if (!degreeCache[studentId]) degreeCache[studentId] = {};
        rows.forEach((row) => { degreeCache[studentId][row.subject] = row.degree; });
        persistDegreeCache();
    }

    // =====================================================================
    // Evaluation data helpers
    // =====================================================================
    // Extract a plain id whether student_id came back populated (object) or as a raw id.
    function studentIdOf(rec) {
        if (rec.student_id && typeof rec.student_id === 'object') return String(rec.student_id._id);
        return String(rec.student_id);
    }

    // GET /tests/:userId returns ONE row per student — an already-aggregated
    // totalDegree, plus the student's own name (not a subject!). There is no
    // per-subject breakdown in this response, so we just map studentId -> total.
    function buildTotalsMap(records) {
        const map = {};
        (records || []).forEach((rec) => {
            const sid = studentIdOf(rec);
            const total = Number(rec.totalDegree);
            map[sid] = isNaN(total) ? 0 : total;
        });
        return map;
    }

    // Local-only per-subject values (see degreeCache above). Used purely to
    // prefill the modal / show a subject count on this device — never as the
    // source of truth for totals, since the server doesn't echo them back.
    function studentSubjectDegrees(studentId) {
        return degreeCache[studentId] || {};
    }

    // Trim to 2 decimals and drop trailing zeros (backend returns decimals
    // like 8.82 / 58.33, not whole percentages).
    function formatDegree(n) {
        const num = Number(n);
        if (isNaN(num)) return '0';
        return String(Math.round(num * 100) / 100);
    }

    // Server-truth total for a student. Falls back to summing the local
    // subject cache only if the server hasn't returned a total yet for this
    // student (e.g. brand new, or a request just failed).
    function studentTotal(studentId) {
        if (totalsMap[studentId] !== undefined) return totalsMap[studentId];
        const entries = Object.values(studentSubjectDegrees(studentId));
        return entries.reduce((sum, d) => sum + (Number(d) || 0), 0);
    }

    // "Average" here is really just a display value for the ring/leaderboard.
    // If we know the local subject breakdown, average across those entries;
    // otherwise fall back to showing the server total directly (we don't know
    // how many subjects contributed to it), and only show — if there's
    // genuinely nothing recorded.
    function studentAverage(studentId) {
        const cached = Object.values(studentSubjectDegrees(studentId));
        if (cached.length > 0) {
            const sum = cached.reduce((s, d) => s + (Number(d) || 0), 0);
            return Math.round((sum / cached.length) * 100) / 100;
        }
        const total = studentTotal(studentId);
        return total > 0 ? total : null;
    }

    function topStudents(limit) {
        return students
            .map((s) => ({ student: s, total: studentTotal(String(s._id || s.id)) }))
            .filter((r) => r.total > 0)
            .sort((a, b) => b.total - a.total)
            .slice(0, limit);
    }

    // Applies the search box + sort dropdown to the current student list,
    // without mutating the underlying `students` array.
    function visibleStudents() {
        let list = students.slice();

        const q = searchQuery.trim().toLowerCase();
        if (q) {
            list = list.filter((s) => (s.name || '').toLowerCase().includes(q));
        }

        const avgOf = (s) => studentAverage(String(s._id || s.id));

        switch (sortMode) {
            case 'avg_desc':
                list.sort((a, b) => (avgOf(b) ?? -1) - (avgOf(a) ?? -1));
                break;
            case 'avg_asc':
                list.sort((a, b) => {
                    const av = avgOf(a), bv = avgOf(b);
                    if (av === null && bv === null) return 0;
                    if (av === null) return 1;
                    if (bv === null) return -1;
                    return av - bv;
                });
                break;
            case 'unrated':
                list.sort((a, b) => {
                    const av = avgOf(a) === null ? 0 : 1;
                    const bv = avgOf(b) === null ? 0 : 1;
                    return av - bv;
                });
                break;
            case 'name':
            default:
                list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar'));
        }

        return list;
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
        return parts[0][0] || '?';
    }

    const TOAST_ICONS = {
        success: 'check_circle',
        error: 'error',
        warning: 'warning',
        info: 'info',
    };

    function showToast(message, type) {
        const icon = TOAST_ICONS[type] || TOAST_ICONS.info;
        toast.innerHTML = `<span class="material-symbols-outlined" style="font-size:18px" aria-hidden="true">${icon}</span><span>${escapeHtml(message)}</span>`;
        toast.className = 'toast show' + (type ? ' ' + type : '');
        clearTimeout(showToast._t);
        showToast._t = setTimeout(() => toast.classList.remove('show'), 2800);
    }

    function ringColor(avg) {
        if (avg === null) return { bg: '#e2e2e2', fg: '#44474d' };
        if (avg >= 80) return { bg: '#d4f5dd', fg: '#1E7D45' };
        if (avg >= 50) return { bg: '#fdd265', fg: '#755900' };
        return { bg: '#ffdad6', fg: '#BA1A1A' };
    }

    function degreeInputClass(val) {
        if (val === '' || val === null || isNaN(val)) return '';
        const n = Number(val);
        if (n >= 80) return 'deg-high';
        if (n >= 50) return 'deg-mid';
        return 'deg-low';
    }

    // =====================================================================
    // Load
    // =====================================================================
    async function render() {
        currentUserId = getActiveUserId();

        // =========================
        // Admin
        // =========================
        if (isAdminMode()) {
            subjects = loadSubjects();

            renderLoading();

            allUsers = await fetchAdminUsers();

            viewingUserId = null;

            sideName.textContent = 'لوحة الإدارة';
            headerSubtitle.textContent = 'اختر محفظاً';

            renderSelectMentor();

            return;
        }

        // =========================
        // Regular محفظ
        // =========================
        if (!currentUserId) {
            renderNoUser();
            return;
        }

        subjects = loadSubjects();

        allUsers = [];
        viewingUserId = currentUserId;

        renderLoading();
        isLoading = true;

        try {
            await loadDataForUser(viewingUserId);
        } catch (err) {
            isLoading = false;
            renderError(err.message);
            return;
        }

        isLoading = false;

        if (students.length === 0) {
            renderNoStudents();
            return;
        }

        renderPage();
    }

    // Fetch students + their test/degree records for a given user,
    // and populate students/totalsMap/header. Reused both on initial render
    // and whenever an admin switches the selected محفظ.
    async function loadDataForUser(userId) {
        const [studentsRes, evaluationsRes] = await Promise.all([
            fetchStudents(userId),
            fetchEvaluations(userId),
        ]);
        students = studentsRes.list;
        totalsMap = buildTotalsMap(evaluationsRes); // <-- totalDegree per student, from GET /tests/:userId
        degreeCache = loadDegreeCache();             // <-- local per-subject breakdown, if any was saved on this device

        if (isAdminMode()) {
            // Admin viewing someone else's students: the admin user list is
            // the authoritative source for that person's name.
            const owner = allUsers.find((u) => String(u._id || u.id) === String(userId));
            currentUserName = (owner && owner.name) || studentsRes.name || currentUserName || 'محفظ غير معروف';
        } else {
            // Regular محفظ viewing their own students: prefer whatever was
            // cached at login; if that's missing, fall back to the name
            // surfaced in the students response and cache it for next time.
            const saved = getActiveUserName();
            currentUserName = saved || studentsRes.name || currentUserName || 'المحفظ';
            if (!saved && studentsRes.name) {
                localStorage.setItem(ACTIVE_USER_NAME_KEY, studentsRes.name);
            }
        }

        headerSubtitle.textContent = `الطلبة: ${students.length}`;
        sideName.textContent = currentUserName;
    }

    // Called when the admin clicks a محفظ chip — either from the initial
    // mentor-selection screen or the small switcher shown atop the page.
    // Keeps the subjects manager + toolbar mounted and only shows a
    // skeleton in the grid/leaderboard area, so the page doesn't reset.
    async function switchViewingUser(userId) {
        if (!userId || userId === viewingUserId) return;
        viewingUserId = userId;
        searchQuery = '';

        if (mainContent.querySelector('#studentsGrid')) {
            isGridLoading = true;
            renderPage();
        } else {
            renderLoading();
        }

        try {
            await loadDataForUser(viewingUserId);
        } catch (err) {
            isGridLoading = false;
            renderError(err.message);
            return;
        }

        isGridLoading = false;

        if (students.length === 0) {
            renderNoStudents();
            return;
        }
        renderPage();
    }

    function mentorChips() {
        return `
            <div class="flex gap-2 overflow-x-auto pb-1" id="adminUsersList" role="group" aria-label="اختيار المحفظ">
                ${allUsers.length
                    ? allUsers.map((u) => {
                        const uid = String(u._id || u.id);
                        const active = String(viewingUserId) === uid;
                        return `
                            <button type="button"
                                class="admin-user-chip flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-bold border transition-colors
                                       ${active ? 'bg-secondary text-primary border-secondary' : 'bg-white/10 text-white border-white/20 hover:bg-white/20'}"
                                aria-pressed="${active}"
                                data-id="${escapeHtml(uid)}">
                                ${escapeHtml(u.name || u.username || uid)}
                            </button>`;
                      }).join('')
                    : `<span class="text-white/40 text-sm">لا يوجد محفظون</span>`
                }
            </div>
        `;
    }

    // =====================================================================
    // Render: admin user-selector shown atop the page once a محفظ is chosen,
    // so the admin can switch to a different one without a full reload.
    // =====================================================================
    function renderUserSelector() {
        if (!isAdminMode() || allUsers.length === 0) return '';
        return `
            <section class="bg-primary rounded-2xl p-4 shadow-sm mb-4 fade-in">
                <div class="flex items-center gap-2 mb-3">
                    <span class="material-symbols-outlined text-secondary" aria-hidden="true">admin_panel_settings</span>
                    <h4 class="text-white font-bold text-sm">لوحة الإدارة</h4>
                </div>
                ${mentorChips()}
            </section>
        `;
    }

    // =====================================================================
    // Render: initial mentor-selection screen (admin only, before any
    // محفظ has been picked). Mirrors attendance.js's renderSelectMentor.
    // =====================================================================
    function renderSelectMentor() {
        mainContent.innerHTML = `
            <section class="bg-primary rounded-2xl p-4 shadow-sm mb-4 fade-in">
                <div class="flex items-center gap-2 mb-3">
                    <span class="material-symbols-outlined text-secondary" aria-hidden="true">admin_panel_settings</span>
                    <h4 class="text-white font-bold text-sm">لوحة الإدارة</h4>
                </div>
                ${mentorChips()}
            </section>
            <section class="flex-1 flex items-center justify-center fade-in py-10">
                <div class="bg-surface-container rounded-2xl p-8 shadow-sm text-center max-w-md w-full">
                    <div class="inline-flex items-center justify-center w-24 h-24 rounded-full bg-secondary/10 mb-4">
                        <span class="material-symbols-outlined text-secondary text-5xl" aria-hidden="true">manage_accounts</span>
                    </div>
                    <h3 class="text-headline-md text-primary font-bold mb-2">اختر محفظاً</h3>
                    <p class="text-body-md text-on-surface-variant">اختر محفظاً من الشريط أعلاه لعرض تقييمات طلبته</p>
                </div>
            </section>
        `;
        document.getElementById('adminUsersList')?.addEventListener('click', (e) => {
            const chip = e.target.closest('.admin-user-chip');
            if (!chip) return;
            switchViewingUser(chip.dataset.id);
        });
    }

    // =====================================================================
    // Render: main page
    // =====================================================================
    function renderPage() {
        const top5 = topStudents(5);
        const visible = visibleStudents();

        mainContent.innerHTML = `
            <section class="mb-5 fade-in">
                <div class="flex items-center justify-between mb-3">
                    <div>
                        <h2 class="text-headline-lg text-primary font-bold flex items-center gap-2">
                            <span class="material-symbols-outlined text-secondary" aria-hidden="true">grading</span>
                            التقييمات
                        </h2>
                        <p class="text-body-md text-on-surface-variant mt-1">أضف المواد ثم اضغط على أي طالب لتسجيل درجاته</p>
                    </div>
                    <button onclick="location.href='dashboard.html'" class="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center shadow-sm hover:bg-surface-container-low transition-colors" aria-label="إغلاق">
                        <span class="material-symbols-outlined text-on-surface-variant" aria-hidden="true">close</span>
                    </button>
                </div>
            </section>

            ${renderUserSelector()}

            <!-- Subjects manager -->
            <section class="bg-surface-container rounded-2xl p-5 shadow-sm mb-4 fade-in" style="animation-delay: 0.05s">
                <label class="text-label-bold text-on-surface-variant mb-2 block" for="subjectInput">إضافة مادة</label>
                <form id="subjectForm" class="flex gap-2">
                    <input type="text" id="subjectInput" class="subject-input" placeholder="مثال: حفظ، تجويد، حديث" autocomplete="off" maxlength="40"/>
                    <button type="submit" class="bg-secondary text-white px-4 rounded-xl font-bold shadow-sm active:scale-95 transition-transform flex items-center justify-center flex-shrink-0" aria-label="إضافة المادة">
                        <span class="material-symbols-outlined" aria-hidden="true">add</span>
                    </button>
                </form>
                <div class="flex flex-wrap gap-2 mt-3">
                    ${subjects.length === 0
                        ? `<p class="text-xs text-on-surface-variant">لم تُضف أي مادة بعد</p>`
                        : subjects.map((s) => `
                            <span class="subject-chip">
                                ${escapeHtml(s)}
                                <button data-remove-subject="${escapeHtml(s)}" type="button" aria-label="إزالة مادة ${escapeHtml(s)}">
                                    <span class="material-symbols-outlined" aria-hidden="true">close</span>
                                </button>
                            </span>
                        `).join('')
                    }
                </div>
            </section>

            <!-- Top 5 leaderboard -->
            <section class="bg-surface-container rounded-2xl p-5 shadow-sm mb-4 fade-in" style="animation-delay: 0.1s">
                <h4 class="text-label-bold text-on-surface-variant font-bold flex items-center gap-1 mb-3">
                    <span class="material-symbols-outlined text-base text-secondary" aria-hidden="true">emoji_events</span>
                    أفضل 5 طلاب
                </h4>
                ${isGridLoading ? renderLeaderboardSkeleton() : (top5.length === 0 ? `
                    <p class="text-xs text-on-surface-variant text-center py-4">لا توجد درجات مسجَّلة بعد</p>
                ` : `
                    <div class="space-y-1" id="leaderboardList">
                        ${top5.map((r, i) => `
                            <div class="flex items-center gap-3 py-1.5 leaderboard-row" data-student-id="${String(r.student._id || r.student.id)}" role="button" tabindex="0">
                                <div class="rank-badge ${i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : 'rank-other'}">
                                    ${i < 3 ? `<span class="material-symbols-outlined" style="font-size:16px" aria-hidden="true">${i === 0 ? 'trophy' : 'military_tech'}</span>` : i + 1}
                                </div>
                                <div class="flex-1 min-w-0">
                                    <p class="text-sm font-bold text-primary truncate">${escapeHtml(r.student.name)}</p>
                                </div>
                                <span class="text-sm font-bold text-secondary flex-shrink-0">${formatDegree(r.total)}</span>
                            </div>
                        `).join('')}
                    </div>
                `)}
            </section>

            <!-- Students grid -->
            <section class="mb-4 fade-in" style="animation-delay: 0.15s">
                <div class="flex items-center justify-between mb-3">
                    <h4 class="text-headline-md text-primary font-bold flex items-center gap-2">
                        <span class="material-symbols-outlined text-secondary" aria-hidden="true">group</span>
                        الطلبة
                    </h4>
                    <span class="text-xs bg-primary/10 text-primary px-2 py-1 rounded-full font-bold">${students.length}</span>
                </div>

                ${students.length > 0 ? `
                <div class="flex gap-2 mb-3">
                    <div class="search-input-wrap">
                        <input type="search" id="studentSearch" class="search-input" placeholder="ابحث عن طالب..." value="${escapeHtml(searchQuery)}" aria-label="ابحث عن طالب"/>
                        <span class="material-symbols-outlined" aria-hidden="true">search</span>
                    </div>
                    <select id="sortSelect" class="sort-select" aria-label="ترتيب حسب">
                        <option value="name" ${sortMode === 'name' ? 'selected' : ''}>الاسم</option>
                        <option value="avg_desc" ${sortMode === 'avg_desc' ? 'selected' : ''}>الأعلى معدلاً</option>
                        <option value="avg_asc" ${sortMode === 'avg_asc' ? 'selected' : ''}>الأقل معدلاً</option>
                        <option value="unrated" ${sortMode === 'unrated' ? 'selected' : ''}>بلا درجات</option>
                    </select>
                </div>
                ` : ''}

                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3" id="studentsGrid" aria-live="polite">
                    ${isGridLoading ? renderGridSkeleton() : renderStudentCards(visible)}
                </div>
            </section>
        `;

        attachPageEvents();
    }

    function renderGridSkeleton() {
        return Array.from({ length: 4 }).map((_, i) => `
            <div class="skeleton-card" style="animation-delay:${i * 40}ms">
                <div class="skeleton skeleton-avatar"></div>
                <div class="flex-1">
                    <div class="skeleton skeleton-line" style="width:60%"></div>
                    <div class="skeleton skeleton-line" style="width:40%;margin-bottom:0"></div>
                </div>
            </div>
        `).join('');
    }

    function renderLeaderboardSkeleton() {
        return `<div class="space-y-2">${Array.from({ length: 3 }).map(() => `
            <div class="flex items-center gap-3 py-1">
                <div class="skeleton" style="width:30px;height:30px;border-radius:50%"></div>
                <div class="skeleton skeleton-line" style="flex:1;margin-bottom:0"></div>
            </div>
        `).join('')}</div>`;
    }

    function renderStudentCards(list) {
        const items = list || students;

        if (items.length === 0) {
            return `
                <div class="col-span-full text-center py-10 text-on-surface-variant">
                    <span class="material-symbols-outlined text-4xl opacity-40" aria-hidden="true">search_off</span>
                    <p class="text-body-md mt-2">لا يوجد طالب يطابق البحث</p>
                </div>
            `;
        }

        return items.map((s, idx) => {
            const id = String(s._id || s.id);
            const avg = studentAverage(id);
            const total = studentTotal(id); // <-- server totalDegree, from GET /tests
            const colors = ringColor(avg);
            const subjectsMarked = Object.keys(studentSubjectDegrees(id)).length;

            let subtitle;
            if (subjectsMarked > 0) {
                subtitle = `${subjectsMarked} مادة مسجَّلة (هذا الجهاز) · المجموع ${formatDegree(total)}`;
            } else if (total > 0) {
                subtitle = `المجموع ${formatDegree(total)}`;
            } else {
                subtitle = 'لا توجد درجات بعد';
            }

            return `
                <div class="student-card flex items-center gap-3" data-student-id="${id}" role="button" tabindex="0"
                     aria-label="فتح درجات ${escapeHtml(s.name)}"
                     style="animation: fadeIn 0.3s ease both; animation-delay: ${idx * 20}ms">
                    <div class="avg-ring" style="background:${colors.bg}; color:${colors.fg}" aria-hidden="true">
                        ${avg === null ? '—' : formatDegree(avg)}
                    </div>
                    <div class="flex-1 min-w-0">
                        <p class="text-body-md font-bold text-primary truncate">${escapeHtml(s.name)}</p>
                        <p class="text-xs text-on-surface-variant mt-0.5">${subtitle}</p>
                        ${avg !== null ? `
                        <div class="progress-track">
                            <div class="progress-fill" style="width:${Math.min(avg, 100)}%; background:${colors.fg}"></div>
                        </div>` : ''}
                    </div>
                    <span class="material-symbols-outlined text-on-surface-variant/50 rtl:-scale-x-100" aria-hidden="true">chevron_left</span>
                </div>
            `;
        }).join('');
    }

    // =====================================================================
    // Events — page level
    // =====================================================================
    function attachPageEvents() {
        const subjectForm = document.getElementById('subjectForm');
        subjectForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const input = document.getElementById('subjectInput');
            addSubject(input.value);
            input.value = '';
            input.focus();
        });

        document.querySelectorAll('[data-remove-subject]').forEach((btn) => {
            btn.addEventListener('click', () => removeSubject(btn.dataset.removeSubject));
        });

        // Student cards — click + keyboard (Enter / Space) activation
        document.querySelectorAll('.student-card').forEach((card) => {
            card.addEventListener('click', () => openDegreeModal(card.dataset.studentId));
            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openDegreeModal(card.dataset.studentId);
                }
            });
        });

        // Leaderboard rows are shortcuts into the same modal
        document.querySelectorAll('.leaderboard-row').forEach((row) => {
            row.addEventListener('click', () => openDegreeModal(row.dataset.studentId));
            row.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openDegreeModal(row.dataset.studentId);
                }
            });
        });

        // Search box — live filter, debounced lightly via input event
        const searchInput = document.getElementById('studentSearch');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                searchQuery = searchInput.value;
                const grid = document.getElementById('studentsGrid');
                grid.innerHTML = renderStudentCards(visibleStudents());
                document.querySelectorAll('.student-card').forEach((card) => {
                    card.addEventListener('click', () => openDegreeModal(card.dataset.studentId));
                    card.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            openDegreeModal(card.dataset.studentId);
                        }
                    });
                });
            });
        }

        // Sort dropdown
        const sortSelect = document.getElementById('sortSelect');
        if (sortSelect) {
            sortSelect.addEventListener('change', () => {
                sortMode = sortSelect.value;
                renderPage();
            });
        }

        // Admin user selector (chips)
        document.getElementById('adminUsersList')?.addEventListener('click', (e) => {
            const chip = e.target.closest('.admin-user-chip');
            if (!chip) return;
            switchViewingUser(chip.dataset.id);
        });
    }

    // =====================================================================
    // Degree entry modal
    // =====================================================================
    function updateDegreeRowStyle(input) {
        const row = input.closest('.degree-input-row');
        input.classList.remove('deg-low', 'deg-mid', 'deg-high');
        const cls = degreeInputClass(input.value);
        if (cls) input.classList.add(cls);
        if (row) row.classList.toggle('has-value', input.value !== '');
    }

    function openDegreeModal(studentId) {
        const student = students.find((s) => String(s._id || s.id) === studentId);
        if (!student) return;

        lastFocusedElement = document.activeElement;
        activeStudentId = studentId;
        modalInitials.textContent = getInitials(student.name);
        modalStudentName.textContent = student.name;
        modalStudentMeta.textContent = student.age ? `${student.age} سنة` : '';

        const current = studentSubjectDegrees(studentId);

        if (subjects.length === 0) {
            modalSubjectsList.innerHTML = '';
            modalNoSubjects.classList.remove('hidden');
            saveDegreesBtn.disabled = true;
        } else {
            modalNoSubjects.classList.add('hidden');
            saveDegreesBtn.disabled = false;
            modalSubjectsList.innerHTML = subjects.map((subj, i) => {
                const existing = current[subj] !== undefined ? current[subj] : '';
                const cls = degreeInputClass(existing);
                return `
                    <div class="degree-input-row ${existing !== '' ? 'has-value' : ''}">
                        <label class="text-sm font-bold text-primary flex-1" for="degree-${escapeHtml(subj)}">${escapeHtml(subj)}</label>
                        <input type="number" inputmode="numeric" min="0" max="100" class="degree-input ${cls}"
                               id="degree-${escapeHtml(subj)}" data-subject="${escapeHtml(subj)}" data-index="${i}"
                               value="${existing}" placeholder="—"/>
                    </div>
                `;
            }).join('');

            // Live color feedback + clamping + Enter-to-next-field
            const inputs = Array.from(modalSubjectsList.querySelectorAll('.degree-input'));
            inputs.forEach((input, i) => {
                input.addEventListener('input', () => updateDegreeRowStyle(input));
                input.addEventListener('blur', () => {
                    if (input.value === '') return;
                    let n = Number(input.value);
                    if (isNaN(n)) { input.value = ''; }
                    else {
                        n = Math.max(0, Math.min(100, Math.round(n)));
                        input.value = n;
                    }
                    updateDegreeRowStyle(input);
                });
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        const next = inputs[i + 1];
                        if (next) next.focus(); else saveDegreesBtn.click();
                    }
                });
            });
        }

        saveDegreesBtnText.textContent = 'حفظ الدرجات';
        degreeModal.classList.remove('hidden');
        degreeModal.classList.add('flex');

        const firstInput = modalSubjectsList.querySelector('.degree-input');
        (firstInput || closeModalBtn).focus();
    }

    function closeDegreeModal() {
        degreeModal.classList.add('hidden');
        degreeModal.classList.remove('flex');
        activeStudentId = null;
        if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
            lastFocusedElement.focus();
        }
    }

    closeModalBtn.addEventListener('click', closeDegreeModal);
    degreeModal.addEventListener('click', (e) => { if (e.target === degreeModal) closeDegreeModal(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !degreeModal.classList.contains('hidden')) closeDegreeModal();
    });

    // Basic focus trap while the modal is open
    degreeModal.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const focusable = degreeModal.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault(); first.focus();
        }
    });

    saveDegreesBtn.addEventListener('click', async () => {
        if (!activeStudentId || isSavingDegrees) return;

        const inputs = Array.from(modalSubjectsList.querySelectorAll('.degree-input'));
        const toSave = inputs
            .map((el) => ({ subject: el.dataset.subject, degree: el.value }))
            .filter((row) => row.degree !== '' && row.degree !== null);

        if (toSave.length === 0) {
            showToast('أدخل درجة مادة واحدة على الأقل', 'error');
            return;
        }

        isSavingDegrees = true;
        saveDegreesBtn.disabled = true;
        saveDegreesBtnText.textContent = 'جارٍ الحفظ...';

        // One batched request: [ { student_id, name, degree }, ... ]
        // Saves go to the currently-viewed user (viewingUserId), which
        // matters when an admin is entering degrees on someone else's behalf.
        const payload = toSave.map((row) => ({
            student_id: activeStudentId,
            name: row.subject,
            degree: Math.max(0, Math.min(100, Number(row.degree))),
        }));

        let saveFailed = false;
        try {
            await saveEvaluations(payload);
            // Cache what was just entered locally (for modal prefill / subject
            // count on this device) — this is NOT the source of truth for totals.
            cacheDegrees(activeStudentId, toSave.map((row) => ({
                subject: row.subject,
                degree: Math.max(0, Math.min(100, Number(row.degree))),
            })));
        } catch (err) {
            saveFailed = true;
        }

        if (!saveFailed) {
            // Re-fetch so the total shown matches exactly what the server
            // computed (we don't try to replicate its aggregation logic here).
            try {
                await loadDataForUser(viewingUserId);
            } catch (err) {
                // Non-fatal: the save itself succeeded, totals will just be
                // stale until the next successful load.
            }
        }

        isSavingDegrees = false;
        saveDegreesBtn.disabled = false;
        saveDegreesBtnText.textContent = 'حفظ الدرجات';

        if (!saveFailed) {
            showToast('✓ تم حفظ الدرجات بنجاح', 'success');
        } else {
            showToast('فشل حفظ الدرجات، حاول مرة أخرى', 'error');
        }

        closeDegreeModal();
        renderPage();
    });

    // =====================================================================
    // Empty / loading / error states
    // =====================================================================
    function renderLoading() {
        mainContent.innerHTML = `
            <section class="flex-1 flex flex-col items-center justify-center py-24 fade-in">
                <div class="spinner mb-4" aria-hidden="true"></div>
                <p class="text-body-md text-on-surface-variant">جارٍ تحميل البيانات...</p>
            </section>
        `;
    }

    function renderError(message) {
        mainContent.innerHTML = `
            <section class="flex-1 flex items-center justify-center fade-in py-10">
                <div class="bg-surface-container rounded-2xl p-8 shadow-sm text-center max-w-md w-full">
                    <div class="inline-flex items-center justify-center w-24 h-24 rounded-full bg-error/10 mb-4">
                        <span class="material-symbols-outlined text-error text-5xl" aria-hidden="true">cloud_off</span>
                    </div>
                    <h3 class="text-headline-md text-primary font-bold mb-2">تعذّر تحميل البيانات</h3>
                    <p class="text-body-md text-on-surface-variant mb-5">${escapeHtml(message)}</p>
                    <button id="retryBtn" class="bg-secondary text-white px-6 py-3 rounded-xl font-bold shadow-md active:scale-95 transition-transform inline-flex items-center gap-2">
                        <span class="material-symbols-outlined" aria-hidden="true">refresh</span>
                        إعادة المحاولة
                    </button>
                </div>
            </section>
        `;
        document.getElementById('retryBtn').addEventListener('click', render);
    }

    function renderNoStudents() {
        mainContent.innerHTML = `
            <section class="flex-1 flex items-center justify-center fade-in py-10">
                <div class="bg-surface-container rounded-2xl p-8 shadow-sm text-center max-w-md w-full">
                    <div class="inline-flex items-center justify-center w-24 h-24 rounded-full bg-secondary/10 mb-4">
                        <span class="material-symbols-outlined text-secondary text-5xl" aria-hidden="true">group_off</span>
                    </div>
                    <h3 class="text-headline-md text-primary font-bold mb-2">لا يوجد طلبة</h3>
                    <p class="text-body-md text-on-surface-variant mb-5">يجب إضافة طلبة أولاً قبل تسجيل التقييمات</p>
                    <div class="flex gap-3">
                        <button onclick="location.href='dashboard.html'" class="flex-1 bg-surface text-on-surface py-3 rounded-xl font-bold border border-outline-variant active:scale-95 transition-transform">رجوع</button>
                        <button onclick="location.href='students.html'" class="flex-1 bg-secondary text-white py-3 rounded-xl font-bold shadow-md active:scale-95 transition-transform flex items-center justify-center gap-2">
                            <span class="material-symbols-outlined" aria-hidden="true">person_add</span>إضافة طالب
                        </button>
                    </div>
                </div>
            </section>
        `;
    }

    function renderNoUser() {
        headerSubtitle.textContent = 'غير مسجل';
        sideName.textContent = '—';
        mainContent.innerHTML = `
            <section class="flex-1 flex items-center justify-center fade-in py-10">
                <div class="bg-surface-container rounded-2xl p-8 shadow-sm text-center max-w-md w-full">
                    <div class="inline-flex items-center justify-center w-24 h-24 rounded-full bg-error/10 mb-4">
                        <span class="material-symbols-outlined text-error text-5xl" aria-hidden="true">warning</span>
                    </div>
                    <h3 class="text-headline-md text-primary font-bold mb-2">لا يوجد محفظ نشط</h3>
                    <p class="text-body-md text-on-surface-variant mb-5">يرجى تسجيل الدخول كمحفظ أولاً</p>
                    <button onclick="location.href='index.html'" class="bg-secondary text-white px-6 py-3 rounded-xl font-bold shadow-md active:scale-95 transition-transform inline-flex items-center gap-2">
                        <span class="material-symbols-outlined" aria-hidden="true">login</span>تسجيل الدخول
                    </button>
                </div>
            </section>
        `;
    }

    // Initial render
    render();
})();
