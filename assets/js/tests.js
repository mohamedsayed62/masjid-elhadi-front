(function () {
    'use strict';

    // =====================================================================
    // CONFIG
    // =====================================================================
    // API base can be overridden per-environment via a small inline script
    // before this file loads:  window.__APP_CONFIG__ = { apiBaseUrl: '...' }
    // Falls back to the previous hardcoded dev value so nothing breaks if
    // that override is absent.
    const CONFIG = {
        API_BASE_URL: 'https://masjid-nodejs-production.up.railway.app/api',
        STUDENTS_ENDPOINT:    (userId) => `/students/${userId}`, // GET  — full student roster for a محفظ
        TESTS_ENDPOINT:       (userId) => `/tests/${userId}`,    // GET  — test/degree records that actually exist
        STORE_TESTS_ENDPOINT: ()       => `/tests`,              // POST — array of { student_id, name, degree }
        ADMIN_USERS_ENDPOINT: '/users/admin/getUsers',           // GET  — requires Authorization: Bearer <token>
        // Soft sanity check only — we don't know each subject's real scale
        // (out of 10? out of 100?), so we warn instead of blocking.
        DEGREE_SANITY_CEILING: 100,
    };

    // Must match whatever the login screens write.
    const ACTIVE_USER_ID_KEY = 'active_user_id';
    const ADMIN_TOKEN_KEY    = 'admin_token';

    // Fallback subjects offered before any real data has loaded.
    const DEFAULT_SUBJECTS = ["القرآن الكريم", "الحديث الشريف شفوي", "الحديث الشريف تحريري", "السلوك"];

    // =====================================================================
    // DOM refs
    // =====================================================================
    const mainContent    = document.getElementById('mainContent');
    const headerSubtitle = document.getElementById('headerSubtitle');
    const sideName       = document.getElementById('sideName');
    const toast          = document.getElementById('toast');

    const degreeModal      = document.getElementById('degreeModal');
    const modalAvatar      = document.getElementById('modalAvatar');
    const modalInitials    = document.getElementById('modalInitials');
    const modalStudentName = document.getElementById('modalStudentName');
    const modalStudentMeta = document.getElementById('modalStudentMeta');
    const modalSubjectsList= document.getElementById('modalSubjectsList');
    const modalNoSubjects  = document.getElementById('modalNoSubjects');
    const closeModalBtn    = document.getElementById('closeModal');
    const saveDegreesBtn   = document.getElementById('saveDegreesBtn');
    const saveDegreesBtnText = document.getElementById('saveDegreesBtnText');

    // Toast needs to actually announce itself to screen readers.
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.setAttribute('aria-atomic', 'true');

    // =====================================================================
    // State
    // =====================================================================
    let adminUsers    = [];   // list of محفظين — admin mode only
    let viewingUserId = null; // محفظ currently selected by the admin

    let students          = [];        // merged roster + test/degree records (see loadStudents)
    let searchQuery        = '';
    let subjectFilter       = '';       // '' = all subjects
    let isLoadingStudents  = false;
    let isSaving           = false;

    let subjectSuggestions = new Set(DEFAULT_SUBJECTS); // grows from real data + session additions

    let activeStudent   = null;  // student currently open in the modal
    let modalSubjects   = [];    // working copy: [{ id, name, degree, isNew }]
    let modalSnapshot    = '';    // JSON snapshot at open time, to detect unsaved edits
    let lastFocusedEl    = null;  // element to restore focus to after modal closes

    let searchDebounceTimer = null;

    // =====================================================================
    // Auth / mode helpers
    // =====================================================================
    function getActiveUserId() { return localStorage.getItem(ACTIVE_USER_ID_KEY); }
    function getAdminToken()   { return localStorage.getItem(ADMIN_TOKEN_KEY); }
    function isAdminMode()     { return !!getAdminToken(); }
    function getEffectiveUserId() { return viewingUserId || getActiveUserId(); }

    // =====================================================================
    // API layer
    // =====================================================================
    async function apiRequest(path, options = {}) {
        const { headers: extraHeaders, ...restOptions } = options;
        let res;
        try {
            res = await fetch(CONFIG.API_BASE_URL + path, {
                headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
                ...restOptions,
            });
        } catch (networkErr) {
            // fetch() throws (not just rejects with res.ok=false) when the
            // network is down entirely — give that a distinct, friendly message.
            throw new Error('تعذّر الاتصال بالخادم. تحقق من اتصال الإنترنت وحاول مجددًا.');
        }

        let body = null;
        try { body = await res.json(); } catch (_) { /* no body */ }

        if (!res.ok || (body && body.status && body.status !== 'success')) {
            throw new Error((body && body.message) || `فشل الطلب (${res.status})`);
        }
        return body;
    }

    function fetchStudentsRoster(userId) {
        return apiRequest(CONFIG.STUDENTS_ENDPOINT(userId), { method: 'GET' })
            .then(body => body.data || []);
    }

    function fetchTests(userId) {
        return apiRequest(CONFIG.TESTS_ENDPOINT(userId), { method: 'GET' })
            .then(body => body.data || []);
    }

    function postTests(entries) {
        return apiRequest(CONFIG.STORE_TESTS_ENDPOINT(), {
            method: 'POST',
            body: JSON.stringify(entries),
        });
    }

    async function fetchAdminUsers() {
        const token = getAdminToken();
        const body  = await apiRequest(CONFIG.ADMIN_USERS_ENDPOINT, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
        });
        document.querySelectorAll('.reports-btn').forEach(e => { e.href = 'reports-admin.html'; });
        return Array.isArray(body.data) ? body.data : [];
    }

    // =====================================================================
    // Admin panel — same pattern used across the app so switching محفظ feels
    // identical on every page. Injected as a sibling BEFORE mainContent.
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

    function paintAdminPanel(loading) {
        if (!adminPanelEl) return;
        const owner = viewingUserId ? adminUsers.find(u => u._id === viewingUserId) : null;

        adminPanelEl.innerHTML = `
            <div class="bg-primary rounded-2xl p-4 shadow-sm mb-3 fade-in">
                <div class="flex items-center gap-2 mb-3">
                    <span class="material-symbols-outlined text-secondary">admin_panel_settings</span>
                    <h4 class="text-white font-bold text-sm">لوحة الإدارة</h4>
                    ${owner
                        ? `<span class="mr-auto bg-secondary text-primary text-xs font-bold px-3 py-1 rounded-full">${escapeHtml(owner.name)}</span>`
                        : `<span class="mr-auto text-white/50 text-xs">اختر محفظاً</span>`}
                </div>
                <div class="flex gap-2 overflow-x-auto pb-1" id="adminUsersList" role="tablist" aria-label="اختيار محفظ">
                    ${loading
                        ? `<div class="flex gap-2">${'<span class="admin-chip-skeleton"></span>'.repeat(3)}</div>`
                        : adminUsers.length
                            ? adminUsers.map(u => `
                                <button type="button" role="tab" aria-selected="${viewingUserId === u._id}"
                                    class="admin-user-chip flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-bold border transition-colors
                                           ${viewingUserId === u._id
                                               ? 'bg-secondary text-primary border-secondary'
                                               : 'bg-white/10 text-white border-white/20 hover:bg-white/20'}"
                                    data-id="${escapeHtml(u._id)}">${escapeHtml(u.name)}</button>`).join('')
                            : `<span class="text-white/40 text-sm">لا يوجد محفظون</span>`}
                </div>
            </div>`;

        document.getElementById('adminUsersList')?.addEventListener('click', e => {
            const chip = e.target.closest('.admin-user-chip');
            if (!chip || chip.dataset.id === viewingUserId) return;

            viewingUserId  = chip.dataset.id;
            students       = [];
            searchQuery    = '';
            subjectFilter  = '';

            paintAdminPanel();
            render();
        });
    }

    async function initAdminPanel() {
        if (!isAdminMode()) return;
        injectAdminPanel();
        paintAdminPanel(true);
        try {
            adminUsers = await fetchAdminUsers();
            paintAdminPanel();
        } catch (err) {
            paintAdminPanel();
            showToast(err.message || 'تعذر تحميل قائمة المحفظين', 'error');
        }
    }

    // =====================================================================
    // Helpers
    // =====================================================================
    function escapeHtml(str) {
        if (!str && str !== 0) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function getInitials(name) {
        const parts = (name || '').trim().split(/\s+/);
        if (parts.length >= 2) return parts[0][0] + parts[1][0];
        return parts[0]?.[0] || '?';
    }

    function showToast(message, type) {
        toast.textContent = message;
        toast.className   = 'toast show' + (type ? ' ' + type : '');
        setTimeout(() => toast.classList.remove('show'), 2800);
    }

    function formatDegree(n) {
        const num = Number(n) || 0;
        return Number.isInteger(num) ? String(num) : num.toFixed(2).replace(/\.?0+$/, '');
    }

    function getStudentId(s) { return String(s.student_id || s._id || s.id); }

    /**
     * Normalize a subject name for comparison/dedup purposes: trims
     * surrounding whitespace and applies Unicode NFKC normalization so
     * visually-identical Arabic strings (different composed forms, stray
     * whitespace) are treated as the same subject instead of silently
     * forking into near-duplicates.
     */
    function normalizeSubjectName(name) {
        return (name || '').trim().normalize('NFKC');
    }

    /**
     * Combine the full student roster with whatever test/degree records
     * exist. GET /tests/{userId} only returns students who already have at
     * least one recorded degree, so on its own it silently hides anyone the
     * محفظ hasn't evaluated yet. Every roster student gets a row here —
     * students without tests just start at totalDegree 0 with no subjects.
     */
    function mergeStudentsWithTests(roster, testsData) {
        const byId = new Map();
        testsData.forEach(t => byId.set(getStudentId(t), t));

        const merged = roster.map(stu => {
            const id    = String(stu._id || stu.id);
            const match = byId.get(id);
            return match
                ? { ...match, student_id: id, name: match.name || stu.name }
                : { student_id: id, name: stu.name, totalDegree: 0, subjects: [] };
        });

        // Defensive: keep any test record whose student no longer appears in
        // the roster (e.g. transferred out) so existing degrees aren't lost.
        const rosterIds = new Set(roster.map(stu => String(stu._id || stu.id)));
        const orphaned  = testsData.filter(t => !rosterIds.has(getStudentId(t)));

        return [...merged, ...orphaned];
    }

    /** Unique, sorted subject names currently held in `students`. */
    function collectSubjectsFromStudents(list) {
        const set = new Set();
        list.forEach(s => (s.subjects || []).forEach(sub => { if (sub.name) set.add(sub.name); }));
        return set;
    }

    /**
     * Single source of truth for "every subject name known so far" — merges
     * names actually present on students with the accumulating suggestions
     * set (defaults + anything typed in this session), normalized so the
     * filter <select> and the add-subject datalist never drift out of sync.
     */
    function getAllKnownSubjects() {
        const set = new Set();
        collectSubjectsFromStudents(students).forEach(name => set.add(normalizeSubjectName(name)));
        subjectSuggestions.forEach(name => set.add(normalizeSubjectName(name)));
        return [...set].sort((a, b) => a.localeCompare(b, 'ar'));
    }

    /** Class-best (max) degree per subject name — used for relative grading colors. */
    function computeSubjectMaxes(list) {
        const maxes = {};
        list.forEach(s => (s.subjects || []).forEach(sub => {
            const d = Number(sub.degree) || 0;
            if (!(sub.name in maxes) || d > maxes[sub.name]) maxes[sub.name] = d;
        }));
        return maxes;
    }

    function gradeColorClasses(degree, max) {
        const ratio = max > 0 ? degree / max : 0;
        if (ratio >= 0.85) return 'bg-success-container text-success';
        if (ratio >= 0.6)  return 'bg-secondary-container text-on-secondary-container';
        if (ratio >= 0.4)  return 'bg-warning/10 text-warning';
        return 'bg-error-container text-error';
    }

    function computeStats() {
        const totals = students.map(s => Number(s.totalDegree) || 0);
        const totalStudents = students.length;
        const avg = totalStudents ? totals.reduce((a, b) => a + b, 0) / totalStudents : 0;
        const max = totalStudents ? Math.max(...totals) : 0;
        const subjectsCount = collectSubjectsFromStudents(students).size;
        return { totalStudents, avg, max, subjectsCount };
    }

    function getTopStudents(n) {
        return [...students]
            .sort((a, b) => (Number(b.totalDegree) || 0) - (Number(a.totalDegree) || 0))
            .slice(0, n);
    }

    /** Count of students who have at least one recorded subject matching `name`. */
    function countStudentsWithSubject(name) {
        return students.filter(s => (s.subjects || []).some(sub => sub.name === name)).length;
    }

    function getVisibleStudents() {
        let ranked = [...students].sort((a, b) => (Number(b.totalDegree) || 0) - (Number(a.totalDegree) || 0));

        if (subjectFilter) {
            ranked = ranked.filter(s => (s.subjects || []).some(sub => sub.name === subjectFilter));
        }
        if (searchQuery.trim()) {
            const q = searchQuery.trim().toLowerCase();
            ranked = ranked.filter(s => (s.name || '').toLowerCase().includes(q));
        }
        return ranked;
    }

    /**
     * Records a subject name into the session's growing suggestions set.
     * The add-subject `<select>` is rebuilt from `getAllKnownSubjects()`
     * every time the modal re-renders, so there's no separate DOM list to
     * keep in sync — just remember the name for next time.
     */
    function registerSubjectName(name) {
        const trimmed = normalizeSubjectName(name);
        if (!trimmed) return;
        subjectSuggestions.add(trimmed);
    }

    // =====================================================================
    // Data loading
    // =====================================================================
    async function loadStudents(userId) {
        // The roster is the source of truth for "who is a student here" — it
        // must succeed for the page to make sense, so its error propagates.
        const roster = await fetchStudentsRoster(userId);

        // Tests, on the other hand, legitimately don't exist yet for a محفظ
        // who hasn't recorded any evaluations — that's not an error state,
        // it just means everyone starts at zero.
        let testsData = [];
        try {
            testsData = await fetchTests(userId);
        } catch (_) {
            testsData = [];
        }

        students = mergeStudentsWithTests(roster, testsData);
        collectSubjectsFromStudents(students).forEach(name => subjectSuggestions.add(normalizeSubjectName(name)));
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

        if (isAdminMode() && viewingUserId) {
            const owner = adminUsers.find(u => u._id === viewingUserId);
            if (owner) sideName.textContent = owner.name;
        }

        renderLoading();
        isLoadingStudents = true;

        try {
            await loadStudents(userId);
        } catch (err) {
            isLoadingStudents = false;
            renderError(err.message);
            return;
        }
        isLoadingStudents = false;

        headerSubtitle.textContent = `الطلبة: ${students.length}`;

        // Only the roster being genuinely empty gets the "no students" state.
        // Students with zero test records still render normally below.
        if (students.length === 0) {
            renderNoStudents();
            return;
        }

        renderPage();
    }

    // =====================================================================
    // Render: main page
    // =====================================================================
    function renderPage() {
        const listEl          = document.getElementById('studentsList');
        const savedScrollTop  = listEl ? listEl.scrollTop : 0;
        const searchHadFocus  = document.activeElement && document.activeElement.id === 'studentSearch';
        const caretPos        = searchHadFocus ? document.activeElement.selectionStart : null;

        const stats    = computeStats();
        const top5     = getTopStudents(5);
        const visible  = getVisibleStudents();
        const allSubjects = [...collectSubjectsFromStudents(students)].sort((a, b) => a.localeCompare(b, 'ar'));

        mainContent.innerHTML = `
            <section class="mb-5 fade-in">
                <div class="flex items-center justify-between mb-3">
                    <div>
                        <h2 class="text-headline-lg text-primary font-bold flex items-center gap-2">
                            <span class="material-symbols-outlined text-secondary">grading</span>التقييمات
                        </h2>
                        <p class="text-body-md text-on-surface-variant mt-1">تابع درجات الطلبة وأضف تقييمات جديدة</p>
                    </div>
                </div>
            </section>

            <section class="grid grid-cols-3 gap-3 mb-5 fade-in" style="animation-delay:.05s">
                <div class="bg-surface-container rounded-2xl p-4 shadow-sm text-center">
                    <div class="text-xl font-bold text-primary">${stats.totalStudents}</div>
                    <div class="text-[11px] text-on-surface-variant font-bold mt-1">طالب</div>
                </div>
                <div class="bg-surface-container rounded-2xl p-4 shadow-sm text-center">
                    <div class="text-xl font-bold text-secondary">${formatDegree(stats.avg)}</div>
                    <div class="text-[11px] text-on-surface-variant font-bold mt-1">متوسط المجموع</div>
                </div>
                <div class="bg-surface-container rounded-2xl p-4 shadow-sm text-center">
                    <div class="text-xl font-bold text-gold">${formatDegree(stats.max)}</div>
                    <div class="text-[11px] text-on-surface-variant font-bold mt-1">أعلى مجموع</div>
                </div>
            </section>

            ${renderLeaderboard(top5, stats.max)}

            <section class="bg-surface-container rounded-2xl shadow-sm mb-4 overflow-hidden fade-in" style="animation-delay:.25s">
                <div class="p-4 border-b border-outline-variant">
                    <div class="flex items-center justify-between mb-3">
                        <h4 class="text-headline-md text-primary font-bold flex items-center gap-2">
                            <span class="material-symbols-outlined text-secondary">group</span>كل الطلبة
                        </h4>
                        <span class="text-xs bg-primary/10 text-primary px-2 py-1 rounded-full font-bold">${visible.length}${visible.length !== students.length ? ` من ${students.length}` : ''}</span>
                    </div>
                    <div class="flex flex-col sm:flex-row gap-2">
                        <div class="relative flex-1">
                            <label for="studentSearch" class="sr-only">ابحث عن طالب بالاسم</label>
                            <span class="material-symbols-outlined absolute top-1/2 -translate-y-1/2 right-3 text-on-surface-variant text-lg pointer-events-none">search</span>
                            <input type="text" id="studentSearch" aria-label="ابحث عن طالب بالاسم"
                                class="w-full bg-surface rounded-xl border border-outline-variant py-2.5 pr-10 pl-9 text-sm focus:outline-none focus:ring-2 focus:ring-secondary/50"
                                placeholder="ابحث عن طالب بالاسم..." value="${escapeHtml(searchQuery)}" autocomplete="off"/>
                            ${searchQuery ? `<button id="clearSearch" aria-label="مسح البحث"
                                class="absolute top-1/2 -translate-y-1/2 left-2 w-6 h-6 flex items-center justify-center rounded-full hover:bg-surface-container-highest">
                                <span class="material-symbols-outlined text-base text-on-surface-variant">close</span>
                            </button>` : ''}
                        </div>
                        ${allSubjects.length ? `
                        <label for="subjectFilterSelect" class="sr-only">تصفية حسب المادة</label>
                        <select id="subjectFilterSelect" aria-label="تصفية حسب المادة"
                            class="bg-surface rounded-xl border border-outline-variant py-2.5 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-secondary/50 sm:w-44">
                            <option value="">كل المواد (${students.length})</option>
                            ${allSubjects.map(name => `<option value="${escapeHtml(name)}" ${subjectFilter === name ? 'selected' : ''}>${escapeHtml(name)} (${countStudentsWithSubject(name)})</option>`).join('')}
                        </select>` : ''}
                    </div>
                </div>
                <div class="divide-y divide-outline-variant max-h-[65vh] overflow-y-auto" id="studentsList" aria-live="polite">
                    ${visible.length ? renderStudentRows(visible) : renderNoSearchResults()}
                </div>
            </section>
        `;

        attachPageEvents();

        if (savedScrollTop > 0) {
            requestAnimationFrame(() => {
                const newListEl = document.getElementById('studentsList');
                if (newListEl) newListEl.scrollTop = savedScrollTop;
            });
        }
        if (searchHadFocus) {
            const input = document.getElementById('studentSearch');
            if (input) { input.focus(); if (caretPos !== null) input.setSelectionRange(caretPos, caretPos); }
        }
    }

    // =====================================================================
    // Render: leaderboard (signature element — medal-ranked top 5)
    // =====================================================================
    const RANK_STYLES = [
        { badge: 'bg-gold text-white',   ring: 'ring-2 ring-gold',   icon: 'workspace_premium', label: 'الأول'  },
        { badge: 'bg-silver text-white', ring: 'ring-2 ring-silver', icon: 'military_tech',      label: 'الثاني' },
        { badge: 'bg-bronze text-white', ring: 'ring-2 ring-bronze', icon: 'military_tech',      label: 'الثالث' },
        { badge: 'bg-primary/10 text-primary', ring: '', icon: '', label: 'الرابع'  },
        { badge: 'bg-primary/10 text-primary', ring: '', icon: '', label: 'الخامس' },
    ];

    function renderLeaderboard(top5, statsMax) {
        if (!top5.length) return '';

        // Every roster student can land in the top 5 with a totalDegree of 0
        // once tests are missing entirely — a "ranking" of all-zeros isn't
        // useful, so point the teacher at the real next step instead.
        if (!statsMax || statsMax <= 0) {
            return `
                <section class="mb-5 fade-in" style="animation-delay:.15s">
                    <div class="bg-surface-container rounded-2xl p-6 text-center shadow-sm border border-dashed border-outline-variant">
                        <span class="material-symbols-outlined text-3xl text-on-surface-variant/40 mb-1 block">emoji_events</span>
                        <p class="text-sm text-on-surface-variant font-bold">لم يتم تسجيل أي تقييمات بعد</p>
                        <p class="text-xs text-on-surface-variant/70 mt-1">اضغط على أي طالب من القائمة أدناه لإضافة أول تقييم له</p>
                    </div>
                </section>`;
        }

        return `
            <section class="mb-5 fade-in" style="animation-delay:.15s">
                <h4 class="text-label-bold text-on-surface-variant font-bold flex items-center gap-1 mb-3">
                    <span class="material-symbols-outlined text-base text-gold">emoji_events</span>الأوائل
                </h4>
                <div class="flex gap-3 overflow-x-auto pb-1">
                    ${top5.map((s, i) => {
                        const style = RANK_STYLES[i] || RANK_STYLES[4];
                        return `
                        <button type="button" data-open-student="${escapeHtml(getStudentId(s))}"
                            class="leaderboard-card flex-shrink-0 w-36 bg-surface-container rounded-2xl p-3 shadow-sm text-center ${style.ring} transition-transform active:scale-95">
                            <div class="w-10 h-10 mx-auto rounded-full flex items-center justify-center font-bold text-sm mb-2 ${style.badge}">
                                ${style.icon ? `<span class="material-symbols-outlined text-lg">${style.icon}</span>` : `#${i + 1}`}
                            </div>
                            <div class="text-body-md font-bold text-primary truncate">${escapeHtml(s.name)}</div>
                            <div class="text-lg font-bold text-secondary mt-1">${formatDegree(s.totalDegree)}</div>
                            <div class="text-[10px] text-on-surface-variant font-bold">${style.label}</div>
                        </button>`;
                    }).join('')}
                </div>
            </section>`;
    }

    // =====================================================================
    // Render: student rows
    // =====================================================================
    function renderStudentRows(list) {
        const maxes = computeSubjectMaxes(students);
        return list.map((s, idx) => {
            const id = getStudentId(s);
            const subjects = s.subjects || [];
            return `
                <div class="p-4 hover:bg-surface transition-colors cursor-pointer" data-open-student="${escapeHtml(id)}"
                    tabindex="0" role="button" aria-label="فتح تقييمات ${escapeHtml(s.name)}"
                    style="animation:fadeIn 0.3s ease both;animation-delay:${Math.min(idx, 20) * 20}ms">
                    <div class="flex items-center gap-3">
                        <div class="w-11 h-11 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                            <span class="text-primary font-bold text-sm">${escapeHtml(getInitials(s.name))}</span>
                        </div>
                        <div class="flex-1 min-w-0">
                            <div class="text-body-md font-bold text-primary truncate">${escapeHtml(s.name)}</div>
                            <div class="flex flex-wrap items-center gap-1.5 mt-1.5">
                                ${subjects.length
                                    ? subjects.map(sub => `
                                        <span class="text-[11px] font-bold px-2 py-0.5 rounded-full ${gradeColorClasses(Number(sub.degree) || 0, maxes[sub.name] || 0)}">
                                            ${escapeHtml(sub.name)} · ${formatDegree(sub.degree)}
                                        </span>`).join('')
                                    : `<span class="text-[11px] text-on-surface-variant/60 italic">لم يُقيَّم بعد — اضغط للإضافة</span>`}
                            </div>
                        </div>
                        <div class="text-left flex-shrink-0">
                            <div class="text-lg font-bold text-secondary">${formatDegree(s.totalDegree)}</div>
                            <div class="text-[10px] text-on-surface-variant font-bold">المجموع</div>
                        </div>
                        <span class="material-symbols-outlined text-on-surface-variant/50 rtl:-scale-x-100">chevron_left</span>
                    </div>
                </div>`;
        }).join('');
    }

    function renderNoSearchResults() {
        return `
            <div class="p-10 text-center">
                <span class="material-symbols-outlined text-4xl text-on-surface-variant/40 mb-2 block">search_off</span>
                <p class="text-sm text-on-surface-variant">لا يوجد طالب مطابق للبحث</p>
                ${(searchQuery || subjectFilter) ? `<button id="resetFilters" class="mt-3 text-sm font-bold text-secondary underline">إعادة ضبط الفلاتر</button>` : ''}
            </div>`;
    }

    // =====================================================================
    // Page-level event wiring
    // =====================================================================
    function attachPageEvents() {
        const searchInput = document.getElementById('studentSearch');
        searchInput?.addEventListener('input', e => {
            const val = e.target.value;
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => { searchQuery = val; renderPage(); }, 150);
        });
        document.getElementById('clearSearch')?.addEventListener('click', () => { searchQuery = ''; renderPage(); });
        document.getElementById('resetFilters')?.addEventListener('click', () => { searchQuery = ''; subjectFilter = ''; renderPage(); });

        document.getElementById('subjectFilterSelect')?.addEventListener('change', e => {
            subjectFilter = e.target.value;
            renderPage();
        });

        document.querySelectorAll('[data-open-student]').forEach(el => {
            const openFn = () => {
                const id = el.dataset.openStudent;
                const student = students.find(s => getStudentId(s) === id);
                if (student) openDegreeModal(student, el);
            };
            el.addEventListener('click', openFn);
            el.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFn(); }
            });
        });
    }

    // =====================================================================
    // Degree modal
    // =====================================================================
    function openDegreeModal(student, triggerEl) {
        activeStudent = student;
        modalSubjects = (student.subjects || []).map((sub, i) => ({
            id: `existing-${i}`,
            name: sub.name,
            degree: Number(sub.degree) || 0,
            isNew: false,
        }));
        modalSnapshot = JSON.stringify(modalSubjects);
        lastFocusedEl = triggerEl || document.activeElement;

        renderModal();
        degreeModal.classList.remove('hidden');
        degreeModal.classList.add('flex');
        degreeModal.setAttribute('role', 'dialog');
        degreeModal.setAttribute('aria-modal', 'true');
        degreeModal.setAttribute('aria-label', `تقييمات ${student.name}`);

        // Move focus into the dialog for keyboard/screen-reader users.
        requestAnimationFrame(() => {
            const firstField = degreeModal.querySelector('input, button, select');
            firstField?.focus();
        });
    }

    function hasUnsavedChanges() {
        return JSON.stringify(modalSubjects) !== modalSnapshot;
    }

    function requestCloseModal() {
        if (hasUnsavedChanges()) {
            const confirmed = window.confirm('توجد تغييرات لم يتم حفظها. هل تريد إغلاق النافذة دون حفظ؟');
            if (!confirmed) return;
        }
        closeDegreeModal();
    }

    function closeDegreeModal() {
        degreeModal.classList.add('hidden');
        degreeModal.classList.remove('flex');
        activeStudent = null;
        modalSubjects = [];
        modalSnapshot = '';
        lastFocusedEl?.focus?.();
        lastFocusedEl = null;
    }

    function renderModal() {
        if (!activeStudent) return;

        modalInitials.textContent    = getInitials(activeStudent.name);
        modalStudentName.textContent = activeStudent.name;
        const total = modalSubjects.reduce((sum, s) => sum + (Number(s.degree) || 0), 0);
        modalStudentMeta.textContent = `${modalSubjects.length} مادة · المجموع الحالي ${formatDegree(total)}`;

        modalNoSubjects.classList.toggle('hidden', modalSubjects.length > 0);

        const hasExistingRows = modalSubjects.some(s => !s.isNew);

        const rowsHtml = modalSubjects.map(sub => `
            <div class="flex items-center gap-2 bg-surface rounded-xl p-3" data-subject-row="${sub.id}">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-1.5">
                        <span class="text-sm font-bold text-primary truncate">${escapeHtml(sub.name)}</span>
                        ${sub.isNew ? `<span class="text-[10px] font-extrabold text-on-secondary-container bg-secondary-container px-1.5 py-0.5 rounded-full flex-shrink-0">جديد</span>` : ''}
                    </div>
                </div>
                <input type="number" step="0.01" min="0" inputmode="decimal"
                    aria-label="درجة ${escapeHtml(sub.name)}"
                    class="w-20 text-center bg-white border border-outline-variant rounded-lg py-1.5 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-secondary/50"
                    data-degree-input="${sub.id}" value="${sub.degree}"/>
                ${sub.isNew ? `
                <button type="button" data-remove-subject="${sub.id}" aria-label="حذف ${escapeHtml(sub.name)}"
                    class="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-lg text-error hover:bg-error-container transition-colors">
                    <span class="material-symbols-outlined text-lg">delete</span>
                </button>` : ''}
            </div>`).join('');

        const NEW_SUBJECT_VALUE = '__new__';
        const knownSubjects = getAllKnownSubjects();

        const addRowHtml = `
            <div class="border border-dashed border-outline-variant rounded-xl p-3">
                <div class="flex items-center gap-2 mb-2">
                    <span class="material-symbols-outlined text-secondary text-lg">add_circle</span>
                    <span class="text-xs font-bold text-on-surface-variant">إضافة مادة</span>
                </div>
                <div class="flex items-center gap-2">
                    <label for="newSubjectSelect" class="sr-only">اختر المادة</label>
                    <select id="newSubjectSelect" aria-label="اختر المادة"
                        class="flex-1 min-w-0 bg-white border border-outline-variant rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-secondary/50">
                        <option value="">-- اختر مادة --</option>
                        ${knownSubjects.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}
                        <option value="${NEW_SUBJECT_VALUE}">+ مادة جديدة...</option>
                    </select>
                    <label for="newSubjectDegree" class="sr-only">درجة المادة الجديدة</label>
                    <input type="number" id="newSubjectDegree" step="0.01" min="0" inputmode="decimal" placeholder="الدرجة" aria-label="درجة المادة الجديدة"
                        class="w-20 text-center bg-white border border-outline-variant rounded-lg py-2 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-secondary/50"/>
                    <button id="addSubjectBtn" type="button" aria-label="إضافة المادة"
                        class="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-lg bg-secondary text-white active:scale-95 transition-transform">
                        <span class="material-symbols-outlined text-lg">add</span>
                    </button>
                </div>
                <div id="newSubjectCustomWrap" class="mt-2 hidden">
                    <label for="newSubjectCustomName" class="sr-only">اسم المادة الجديدة</label>
                    <input type="text" id="newSubjectCustomName" placeholder="اكتب اسم المادة الجديدة" aria-label="اسم المادة الجديدة"
                        class="w-full bg-white border border-outline-variant rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-secondary/50" autocomplete="off"/>
                </div>
                <p id="newSubjectHint" class="text-[11px] text-secondary font-bold pt-1.5 hidden"></p>
            </div>
            ${hasExistingRows ? `<p class="text-[11px] text-on-surface-variant/70 text-center pt-1">لحذف مادة محفوظة سابقًا، تواصل مع الإدارة</p>` : ''}`;

        modalSubjectsList.innerHTML = rowsHtml + addRowHtml;

        modalSubjectsList.querySelectorAll('[data-degree-input]').forEach(input => {
            input.addEventListener('input', () => {
                const row = modalSubjects.find(s => s.id === input.dataset.degreeInput);
                if (!row) return;
                row.degree = Number(input.value) || 0;
                modalStudentMeta.textContent = `${modalSubjects.length} مادة · المجموع الحالي ${formatDegree(modalSubjects.reduce((sum, s) => sum + (Number(s.degree) || 0), 0))}`;
            });
            input.addEventListener('blur', () => {
                const val = Number(input.value);
                if (val > CONFIG.DEGREE_SANITY_CEILING) {
                    showToast(`تنبيه: الدرجة ${formatDegree(val)} تبدو كبيرة، تأكد من صحتها`, 'warning');
                }
            });
        });

        modalSubjectsList.querySelectorAll('[data-remove-subject]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.removeSubject;
                modalSubjects = modalSubjects.filter(s => s.id !== id);
                renderModal();
            });
        });

        document.getElementById('addSubjectBtn').addEventListener('click', handleAddSubject);

        const newSubjectSelect     = document.getElementById('newSubjectSelect');
        const newSubjectCustomWrap = document.getElementById('newSubjectCustomWrap');
        const newSubjectCustomName = document.getElementById('newSubjectCustomName');
        const newSubjectDegree     = document.getElementById('newSubjectDegree');
        const newSubjectHint       = document.getElementById('newSubjectHint');

        // Toggle the free-text field only for the explicit "new subject" choice.
        newSubjectSelect.addEventListener('change', () => {
            const isCustom = newSubjectSelect.value === NEW_SUBJECT_VALUE;
            newSubjectCustomWrap.classList.toggle('hidden', !isCustom);
            if (isCustom) {
                newSubjectCustomName.focus();
            } else {
                updateNewSubjectHint(newSubjectSelect.value);
            }
        });

        function updateNewSubjectHint(name) {
            const normalized = normalizeSubjectName(name);
            const existing = normalized && modalSubjects.find(s => normalizeSubjectName(s.name) === normalized);
            if (existing) {
                newSubjectHint.textContent = `سيتم تحديث درجة "${existing.name}" الحالية بدلًا من إضافة مادة جديدة`;
                newSubjectHint.classList.remove('hidden');
            } else {
                newSubjectHint.classList.add('hidden');
            }
        }

        // Live feedback so a teacher finds out about a name collision before
        // they submit, instead of only via a toast afterward.
        newSubjectCustomName.addEventListener('input', () => updateNewSubjectHint(newSubjectCustomName.value));
        newSubjectCustomName.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); handleAddSubject(); }
        });
        newSubjectDegree.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); handleAddSubject(); }
        });
    }

    /** Resolves the subject name currently chosen in the add-subject row (dropdown pick, or the custom field when "+ مادة جديدة" is selected). */
    function getSelectedNewSubjectName() {
        const select = document.getElementById('newSubjectSelect');
        if (select.value === '__new__') {
            return normalizeSubjectName(document.getElementById('newSubjectCustomName').value);
        }
        return normalizeSubjectName(select.value);
    }

    function handleAddSubject() {
        const select       = document.getElementById('newSubjectSelect');
        const isCustom     = select.value === '__new__';
        const focusTarget  = isCustom ? document.getElementById('newSubjectCustomName') : select;
        const degreeInput  = document.getElementById('newSubjectDegree');
        const name   = getSelectedNewSubjectName();
        const degree = Number(degreeInput.value);

        if (!select.value) { showToast('يرجى اختيار مادة', 'error'); select.focus(); return; }
        if (!name) { showToast('يرجى إدخال اسم المادة الجديدة', 'error'); focusTarget.focus(); return; }
        if (Number.isNaN(degree) || degree < 0) { showToast('يرجى إدخال درجة صحيحة', 'error'); degreeInput.focus(); return; }
        if (degree > CONFIG.DEGREE_SANITY_CEILING) {
            showToast(`تنبيه: الدرجة ${formatDegree(degree)} تبدو كبيرة، تأكد من صحتها`, 'warning');
        }

        const existing = modalSubjects.find(s => normalizeSubjectName(s.name) === name);
        if (existing) {
            existing.degree = degree;
        } else {
            modalSubjects.push({ id: `new-${Date.now()}`, name, degree, isNew: true });
        }

        registerSubjectName(name);
        renderModal();
        // Keep focus in the add-row so a teacher can rapid-fire several subjects.
        document.getElementById('newSubjectSelect')?.focus();
        showToast(`✓ تمت إضافة "${name}"`, 'success');
    }

    async function handleSaveDegrees() {
        if (!activeStudent) return;
        if (modalSubjects.length === 0) { showToast('أضف مادة واحدة على الأقل قبل الحفظ', 'error'); return; }

        const studentId = getStudentId(activeStudent);
        const payload = modalSubjects.map(s => ({
            student_id: studentId,
            name: s.name,
            degree: Number(s.degree) || 0,
        }));

        isSaving = true;
        saveDegreesBtn.disabled = true;
        saveDegreesBtnText.textContent = 'جارٍ الحفظ...';

        try {
            await postTests(payload);

            // Optimistic local update: reflect the save immediately instead of
            // showing a full-page skeleton again, then quietly reconcile with
            // the server in the background.
            const idx = students.findIndex(s => getStudentId(s) === studentId);
            if (idx !== -1) {
                students[idx] = {
                    ...students[idx],
                    subjects: modalSubjects.map(s => ({ name: s.name, degree: Number(s.degree) || 0 })),
                    totalDegree: modalSubjects.reduce((sum, s) => sum + (Number(s.degree) || 0), 0),
                };
            }

            showToast('✓ تم حفظ الدرجات بنجاح', 'success');
            closeDegreeModal();
            headerSubtitle.textContent = `الطلبة: ${students.length}`;
            renderPage();

            // Background reconciliation — if the server computes totals
            // differently (weights, rounding, etc.) this quietly corrects it.
            const userId = getEffectiveUserId();
            loadStudents(userId).then(renderPage).catch(() => { /* non-fatal, UI already reflects the save */ });
        } catch (err) {
            showToast(err.message || 'حدث خطأ أثناء الحفظ', 'error');
        } finally {
            isSaving = false;
            saveDegreesBtn.disabled = false;
            saveDegreesBtnText.textContent = 'حفظ الدرجات';
        }
    }

    closeModalBtn.addEventListener('click', requestCloseModal);
    saveDegreesBtn.addEventListener('click', handleSaveDegrees);
    degreeModal.addEventListener('click', e => { if (e.target === degreeModal) requestCloseModal(); });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !degreeModal.classList.contains('hidden')) requestCloseModal();

        // Minimal focus trap while the modal is open.
        if (e.key === 'Tab' && !degreeModal.classList.contains('hidden')) {
            const focusable = degreeModal.querySelectorAll('input, button, select, [tabindex]:not([tabindex="-1"])');
            if (!focusable.length) return;
            const first = focusable[0];
            const last  = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    });

    // =====================================================================
    // Empty / loading / error states
    // =====================================================================
    function renderLoading() {
        mainContent.innerHTML = `
            <section class="space-y-3" aria-busy="true" aria-label="جارٍ التحميل">
                <div class="skeleton-block h-8 w-2/3 rounded-lg"></div>
                <div class="grid grid-cols-3 gap-3">
                    ${'<div class="skeleton-block h-16 rounded-2xl"></div>'.repeat(3)}
                </div>
                <div class="skeleton-block h-24 rounded-2xl"></div>
                ${'<div class="skeleton-block h-20 rounded-2xl"></div>'.repeat(4)}
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
                    <p class="text-body-md text-on-surface-variant mb-5">يجب إضافة طلبة أولاً قبل تسجيل التقييمات</p>
                    <button onclick="location.href='students.html'" class="bg-secondary text-white px-6 py-3 rounded-xl font-bold shadow-md active:scale-95 transition-transform inline-flex items-center gap-2">
                        <span class="material-symbols-outlined">person_add</span>إضافة طالب
                    </button>
                </div>
            </section>`;
    }

    function renderSelectMentor() {
        mainContent.innerHTML = `
            <section class="flex-1 flex items-center justify-center fade-in py-10">
                <div class="bg-surface-container rounded-2xl p-8 shadow-sm text-center max-w-md w-full">
                    <div class="inline-flex items-center justify-center w-24 h-24 rounded-full bg-secondary/10 mb-4">
                        <span class="material-symbols-outlined text-secondary text-5xl">manage_accounts</span>
                    </div>
                    <h3 class="text-headline-md text-primary font-bold mb-2">اختر محفظاً</h3>
                    <p class="text-body-md text-on-surface-variant">اختر محفظاً من الشريط أعلاه لعرض تقييمات طلبته</p>
                </div>
            </section>`;
    }

    function renderNoUser() {
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
