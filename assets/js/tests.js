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
    };

    // LocalStorage keys — must match whatever the login screens write.
    const ACTIVE_USER_ID_KEY = 'active_user_id';
    const ADMIN_TOKEN_KEY    = 'admin_token';   // set by admin login; absent for regular محفظ

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
    let evalMap = {};                  // { studentId: { subjectName: { degree, _id } } }
    let activeStudentId = null;        // student currently open in the modal

    // --- admin / user-switching state -----------------------------
    let allUsers = [];                  // list of محفظين returned by the admin endpoint (admin only)
    let viewingUserId = null;           // whose students/degrees are currently shown.
                                         // Regular محفظ: set to currentUserId immediately.
                                         // Admin: stays null until they click a محفظ chip —
                                         // no student data loads before that click.

    let isLoading = false;
    let isSavingDegrees = false;

    // =====================================================================
    // Auth / mode helpers — same pattern as attendance.js
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
          .then((body) => body.data || []);
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
        if (subjects.some((s) => s === trimmed)) {
            showToast('هذه المادة مضافة بالفعل', 'warning');
            return;
        }
        subjects.push(trimmed);
        persistSubjects();
        renderPage();
    }

    function removeSubject(name) {
        subjects = subjects.filter((s) => s !== name);
        persistSubjects();
        renderPage();
    }

    // =====================================================================
    // Evaluation data helpers
    // =====================================================================
    // Extract a plain id whether student_id came back populated (object) or as a raw id.
    function studentIdOf(rec) {
        if (rec.student_id && typeof rec.student_id === 'object') return String(rec.student_id._id);
        return String(rec.student_id);
    }

    // Build { studentId: { subjectName: { degree, _id } } }, keeping the most
    // recent record per (student, subject) pair when duplicates exist —
    // Mongo ObjectIds sort chronologically as strings, so the last one after
    // a stable sort by _id is the latest entry.
    function buildEvalMap(records) {
        const sorted = [...records].sort((a, b) => String(a._id).localeCompare(String(b._id)));
        const map = {};
        sorted.forEach((rec) => {
            const sid = studentIdOf(rec);
            if (!map[sid]) map[sid] = {};
            map[sid][rec.name] = { degree: rec.degree, _id: rec._id };
        });
        return map;
    }

    function studentSubjectDegrees(studentId) {
        return evalMap[studentId] || {};
    }

    function studentTotal(studentId) {
        const entries = studentSubjectDegrees(studentId);
        return Object.values(entries).reduce((sum, e) => sum + (Number(e.degree) || 0), 0);
    }

    function studentAverage(studentId) {
        const entries = Object.values(studentSubjectDegrees(studentId));
        if (entries.length === 0) return null;
        const sum = entries.reduce((s, e) => s + (Number(e.degree) || 0), 0);
        return Math.round(sum / entries.length);
    }

    function topStudents(limit) {
        return students
            .map((s) => ({ student: s, total: studentTotal(String(s._id || s.id)) }))
            .filter((r) => r.total > 0)
            .sort((a, b) => b.total - a.total)
            .slice(0, limit);
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

    function showToast(message, type) {
        toast.textContent = message;
        toast.className = 'toast show' + (type ? ' ' + type : '');
        setTimeout(() => toast.classList.remove('show'), 2800);
    }

    function ringColor(avg) {
        if (avg === null) return { bg: '#e2e2e2', fg: '#44474d' };
        if (avg >= 80) return { bg: '#d4f5dd', fg: '#1E7D45' };
        if (avg >= 50) return { bg: '#fdd265', fg: '#755900' };
        return { bg: '#ffdad6', fg: '#BA1A1A' };
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
    // and populate students/evalMap/header. Reused both on initial render
    // and whenever an admin switches the selected محفظ.
    async function loadDataForUser(userId) {
        const [studentsRes, evaluationsRes] = await Promise.all([
            fetchStudents(userId),
            fetchEvaluations(userId),
        ]);
        students = studentsRes;
        evalMap = buildEvalMap(evaluationsRes); // <-- degrees for every student, from GET /tests/:userId

        const owner = allUsers.find((u) => String(u._id || u.id) === String(userId));
        currentUserName = (owner && owner.name) || currentUserName;

        headerSubtitle.textContent = `الطلبة: ${students.length}`;
        sideName.textContent = currentUserName || 'المحفظ';
    }

    // Called when the admin clicks a محفظ chip — either from the initial
    // mentor-selection screen or the small switcher shown atop the page.
    // This is the point the first (and only) student/degree request fires.
    async function switchViewingUser(userId) {
        if (!userId || userId === viewingUserId) return;
        viewingUserId = userId;
        renderLoading();
        try {
            await loadDataForUser(viewingUserId);
        } catch (err) {
            renderError(err.message);
            return;
        }
        if (students.length === 0) {
            renderNoStudents();
            return;
        }
        renderPage();
    }

    function mentorChips() {
        return `
            <div class="flex gap-2 overflow-x-auto pb-1" id="adminUsersList">
                ${allUsers.length
                    ? allUsers.map((u) => {
                        const uid = String(u._id || u.id);
                        const active = String(viewingUserId) === uid;
                        return `
                            <button type="button"
                                class="admin-user-chip flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-bold border transition-colors
                                       ${active ? 'bg-secondary text-primary border-secondary' : 'bg-white/10 text-white border-white/20 hover:bg-white/20'}"
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
                    <span class="material-symbols-outlined text-secondary">admin_panel_settings</span>
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
                    <span class="material-symbols-outlined text-secondary">admin_panel_settings</span>
                    <h4 class="text-white font-bold text-sm">لوحة الإدارة</h4>
                </div>
                ${mentorChips()}
            </section>
            <section class="flex-1 flex items-center justify-center fade-in py-10">
                <div class="bg-surface-container rounded-2xl p-8 shadow-sm text-center max-w-md w-full">
                    <div class="inline-flex items-center justify-center w-24 h-24 rounded-full bg-secondary/10 mb-4">
                        <span class="material-symbols-outlined text-secondary text-5xl">manage_accounts</span>
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

        mainContent.innerHTML = `
            <section class="mb-5 fade-in">
                <div class="flex items-center justify-between mb-3">
                    <div>
                        <h2 class="text-headline-lg text-primary font-bold flex items-center gap-2">
                            <span class="material-symbols-outlined text-secondary">grading</span>
                            التقييمات
                        </h2>
                        <p class="text-body-md text-on-surface-variant mt-1">أضف المواد ثم اضغط على أي طالب لتسجيل درجاته</p>
                    </div>
                    <button onclick="location.href='dashboard.html'" class="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center shadow-sm hover:bg-surface-container-low transition-colors">
                        <span class="material-symbols-outlined text-on-surface-variant">close</span>
                    </button>
                </div>
            </section>

            ${renderUserSelector()}

            <!-- Subjects manager -->
            <section class="bg-surface-container rounded-2xl p-5 shadow-sm mb-4 fade-in" style="animation-delay: 0.05s">
                <label class="text-label-bold text-on-surface-variant mb-2 block">إضافة مادة</label>
                <form id="subjectForm" class="flex gap-2">
                    <input type="text" id="subjectInput" class="subject-input" placeholder="مثال: حفظ، تجويد، حديث" autocomplete="off"/>
                    <button type="submit" class="bg-secondary text-white px-4 rounded-xl font-bold shadow-sm active:scale-95 transition-transform flex items-center justify-center flex-shrink-0">
                        <span class="material-symbols-outlined">add</span>
                    </button>
                </form>
                <div class="flex flex-wrap gap-2 mt-3">
                    ${subjects.length === 0
                        ? `<p class="text-xs text-on-surface-variant">لم تُضف أي مادة بعد</p>`
                        : subjects.map((s) => `
                            <span class="subject-chip">
                                ${escapeHtml(s)}
                                <button data-remove-subject="${escapeHtml(s)}" type="button">
                                    <span class="material-symbols-outlined">close</span>
                                </button>
                            </span>
                        `).join('')
                    }
                </div>
            </section>

            <!-- Top 5 leaderboard -->
            <section class="bg-surface-container rounded-2xl p-5 shadow-sm mb-4 fade-in" style="animation-delay: 0.1s">
                <h4 class="text-label-bold text-on-surface-variant font-bold flex items-center gap-1 mb-3">
                    <span class="material-symbols-outlined text-base text-secondary">emoji_events</span>
                    أفضل 5 طلاب
                </h4>
                ${top5.length === 0 ? `
                    <p class="text-xs text-on-surface-variant text-center py-4">لا توجد درجات مسجَّلة بعد</p>
                ` : `
                    <div class="space-y-2">
                        ${top5.map((r, i) => `
                            <div class="flex items-center gap-3 py-1.5">
                                <div class="rank-badge ${i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : 'rank-other'}">${i + 1}</div>
                                <div class="flex-1 min-w-0">
                                    <p class="text-sm font-bold text-primary truncate">${escapeHtml(r.student.name)}</p>
                                </div>
                                <span class="text-sm font-bold text-secondary flex-shrink-0">${r.total}</span>
                            </div>
                        `).join('')}
                    </div>
                `}
            </section>

            <!-- Students grid -->
            <section class="mb-4 fade-in" style="animation-delay: 0.15s">
                <div class="flex items-center justify-between mb-3">
                    <h4 class="text-headline-md text-primary font-bold flex items-center gap-2">
                        <span class="material-symbols-outlined text-secondary">group</span>
                        الطلبة
                    </h4>
                    <span class="text-xs bg-primary/10 text-primary px-2 py-1 rounded-full font-bold">${students.length}</span>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3" id="studentsGrid">
                    ${renderStudentCards()}
                </div>
            </section>
        `;

        attachPageEvents();
    }

    function renderStudentCards() {
        return students.map((s, idx) => {
            const id = String(s._id || s.id);
            const avg = studentAverage(id);
            const total = studentTotal(id); // <-- degree total, populated right after GET /tests
            const colors = ringColor(avg);
            const subjectsMarked = Object.keys(studentSubjectDegrees(id)).length;
            return `
                <div class="student-card flex items-center gap-3" data-student-id="${id}" style="animation: fadeIn 0.3s ease both; animation-delay: ${idx * 20}ms">
                    <div class="avg-ring" style="background:${colors.bg}; color:${colors.fg}">
                        ${avg === null ? '—' : avg}
                    </div>
                    <div class="flex-1 min-w-0">
                        <p class="text-body-md font-bold text-primary truncate">${escapeHtml(s.name)}</p>
                        <p class="text-xs text-on-surface-variant mt-0.5">
                            ${subjectsMarked > 0 ? `${subjectsMarked} مادة مسجَّلة · المجموع ${total}` : 'لا توجد درجات بعد'}
                        </p>
                    </div>
                    <span class="material-symbols-outlined text-on-surface-variant/50 rtl:-scale-x-100">chevron_left</span>
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

        document.querySelectorAll('.student-card').forEach((card) => {
            card.addEventListener('click', () => openDegreeModal(card.dataset.studentId));
        });

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
    function openDegreeModal(studentId) {
        const student = students.find((s) => String(s._id || s.id) === studentId);
        if (!student) return;

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
            modalSubjectsList.innerHTML = subjects.map((subj) => {
                const existing = current[subj] ? current[subj].degree : '';
                return `
                    <div class="degree-input-row">
                        <label class="text-sm font-bold text-primary flex-1" for="degree-${escapeHtml(subj)}">${escapeHtml(subj)}</label>
                        <input type="number" min="0" max="100" class="degree-input" id="degree-${escapeHtml(subj)}" data-subject="${escapeHtml(subj)}" value="${existing}" placeholder="—"/>
                    </div>
                `;
            }).join('');
        }

        saveDegreesBtnText.textContent = 'حفظ الدرجات';
        degreeModal.classList.remove('hidden');
        degreeModal.classList.add('flex');
    }

    function closeDegreeModal() {
        degreeModal.classList.add('hidden');
        degreeModal.classList.remove('flex');
        activeStudentId = null;
    }

    closeModalBtn.addEventListener('click', closeDegreeModal);
    degreeModal.addEventListener('click', (e) => { if (e.target === degreeModal) closeDegreeModal(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !degreeModal.classList.contains('hidden')) closeDegreeModal();
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
            degree: Number(row.degree),
        }));

        let saveFailed = false;
        try {
            await saveEvaluations(payload);
            // Update local state optimistically so the card/leaderboard
            // reflect the change without a full refetch.
            if (!evalMap[activeStudentId]) evalMap[activeStudentId] = {};
            payload.forEach((row) => {
                evalMap[activeStudentId][row.name] = { degree: row.degree, _id: 'local' };
            });
        } catch (err) {
            saveFailed = true;
        }

        isSavingDegrees = false;
        saveDegreesBtn.disabled = false;
        saveDegreesBtnText.textContent = 'حفظ الدرجات';

        if (!saveFailed) {
            showToast('✓ تم حفظ الدرجات بنجاح', 'success');
        } else {
            showToast('فشل حفظ الدرجات', 'error');
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
                <div class="spinner mb-4"></div>
                <p class="text-body-md text-on-surface-variant">جارٍ تحميل البيانات...</p>
            </section>
        `;
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
                        <span class="material-symbols-outlined">refresh</span>
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
                        <span class="material-symbols-outlined text-secondary text-5xl">group_off</span>
                    </div>
                    <h3 class="text-headline-md text-primary font-bold mb-2">لا يوجد طلبة</h3>
                    <p class="text-body-md text-on-surface-variant mb-5">يجب إضافة طلبة أولاً قبل تسجيل التقييمات</p>
                    <div class="flex gap-3">
                        <button onclick="location.href='dashboard.html'" class="flex-1 bg-surface text-on-surface py-3 rounded-xl font-bold border border-outline-variant active:scale-95 transition-transform">رجوع</button>
                        <button onclick="location.href='students.html'" class="flex-1 bg-secondary text-white py-3 rounded-xl font-bold shadow-md active:scale-95 transition-transform flex items-center justify-center gap-2">
                            <span class="material-symbols-outlined">person_add</span>إضافة طالب
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
                        <span class="material-symbols-outlined text-error text-5xl">warning</span>
                    </div>
                    <h3 class="text-headline-md text-primary font-bold mb-2">لا يوجد محفظ نشط</h3>
                    <p class="text-body-md text-on-surface-variant mb-5">يرجى تسجيل الدخول كمحفظ أولاً</p>
                    <button onclick="location.href='index.html'" class="bg-secondary text-white px-6 py-3 rounded-xl font-bold shadow-md active:scale-95 transition-transform inline-flex items-center gap-2">
                        <span class="material-symbols-outlined">login</span>تسجيل الدخول
                    </button>
                </div>
            </section>
        `;
    }

    // Initial render
    render();
})();
