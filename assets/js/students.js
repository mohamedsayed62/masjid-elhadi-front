(function () {
    // =====================================================================
    // CONFIG — matches the pattern used in the login/registration screen.
    // =====================================================================
    const API_BASE_URL = 'https://masjid-nodejs-production.up.railway.app/api'; // TODO: set real base URL

    // TODO: confirm the real route your router mounts `staticts` on.
    // The handler does: user.findById(req.params.id) then
    // student.find({ userId: getUser.id }) — so it expects the WALLET
    // (user) id as :id. Adjust the path below to match your router, e.g.
    // it might be `/users/:id/students` or `/statistics/:id` instead.
    const STUDENTS_ENDPOINT = (userId) => `${API_BASE_URL}/students/${userId}`;

    // getStudent handler reads req.params.id -> GET /students/:id
    const STUDENT_BY_ID_ENDPOINT = (studentId) => `${API_BASE_URL}/students/${studentId}`;

    // updateStudent handler reads req.body.id (NOT req.params.id) and does
    // findOneAndUpdate({ _id: req.body.id }, { ...req.body }). So the id
    // must travel inside the body, not the URL. Adjust method/path if your
    // router expects something different (e.g. PATCH vs PUT).
    const UPDATE_STUDENT_ENDPOINT = `${API_BASE_URL}/students`;

    // Move-to-another-محفظ handler: POST /students/editUser, requires an
    // Authorization: Bearer <admin token> header, body: { id, userId }.
    // Confirmed response shape: { status, message, code, data: { _id, userId, ... } }.
    const MOVE_STUDENT_ENDPOINT = `${API_BASE_URL}/students/editUser`;

    // NEW — admin: list all محفظين (wallet holders / mentors).
    // TODO: confirm the real route; from your sample it's
    // GET /api/users/admin/getUsers with an Authorization: Bearer <token> header.
    const ADMIN_USERS_ENDPOINT = `${API_BASE_URL}/users/admin/getUsers`;

    // Only the id is ever read from localStorage — same key the login
    // screen writes. Nothing about the students themselves is cached.
    const ACTIVE_USER_ID_KEY = 'active_user_id';

    // NEW — the key an admin's auth token is expected to be stored under.
    // TODO: confirm this matches whatever key your admin login screen writes.
    const ADMIN_TOKEN_KEY = 'admin_token';

    // =====================================================================
    // DOM references
    // =====================================================================
    const headerSubtitle = document.getElementById('headerSubtitle');
    const sideName = document.getElementById('sideName');
    const countSubtitle = document.getElementById('countSubtitle');
    const searchSection = document.getElementById('searchSection');
    const searchInput = document.getElementById('searchInput');

    const loadingState = document.getElementById('loadingState');
    const errorState = document.getElementById('errorState');
    const errorMessage = document.getElementById('errorMessage');
    const noWalletState = document.getElementById('noWalletState');
    const emptyState = document.getElementById('emptyState');
    const noResultsState = document.getElementById('noResultsState');
    const studentsList = document.getElementById('studentsList');

    // NEW — admin panel + select-a-محفظ prompt
    const adminPanel = document.getElementById('adminPanel');
    const adminUsersListEl = document.getElementById('adminUsersList');
    const selectMentorState = document.getElementById('selectMentorState');

    const retryBtn = document.getElementById('retryBtn');
    const refreshBtnDesktop = document.getElementById('refreshBtnDesktop');
    const refreshBtnMobile = document.getElementById('refreshBtnMobile');
    const toast = document.getElementById('toast');

    // NEW — the floating "add student" button. Give it id="addStudentBtn"
    // in the HTML and drop its old inline onclick="location.href=...".
    const addStudentBtn = document.getElementById('addStudentBtn');

    const deleteOverlay     = document.getElementById('deleteOverlay');
    const deleteStudentName = document.getElementById('deleteStudentName');
    const cancelDeleteBtn   = document.getElementById('cancelDeleteBtn');
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
    let pendingDeleteId = null;

    // --- Edit dialog DOM refs -------------------------------------------
    const editOverlay      = document.getElementById('editOverlay');
    const editForm          = document.getElementById('editForm');
    const editIdInput       = document.getElementById('editId');
    const editNameInput     = document.getElementById('editName');
    const editParentInput   = document.getElementById('editParentName');
    const editPhoneInput    = document.getElementById('editPhone');
    const editAgeInput      = document.getElementById('editAge');
    const editGenderSelect  = document.getElementById('editGender');
    const cancelEditBtn     = document.getElementById('cancelEditBtn');
    const confirmEditBtn    = document.getElementById('confirmEditBtn');
    const editLoading       = document.getElementById('editLoading');

    // --- Move dialog DOM refs ---------------------------------------------
    const moveOverlay       = document.getElementById('moveOverlay');
    const moveStudentNameEl = document.getElementById('moveStudentName');
    const moveTargetSelect  = document.getElementById('moveTargetSelect');
    const cancelMoveBtn     = document.getElementById('cancelMoveBtn');
    const confirmMoveBtn    = document.getElementById('confirmMoveBtn');
    let pendingMoveId = null;

    let allStudents = [];
    let adminUsers = [];       // list of محفظين, only populated in admin mode
    let viewingUserId = null;  // the محفظ currently selected by the admin

    // =====================================================================
    // Helpers
    // =====================================================================
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }

    function getInitials(name) {
        const parts = (name || '').trim().split(/\s+/);
        if (parts.length >= 2) return parts[0][0] + parts[1][0];
        return parts[0] ? parts[0][0] : '؟';
    }

    function showToast(message, type) {
        toast.textContent = message;
        toast.className = 'toast show' + (type ? ' ' + type : '');
        setTimeout(() => toast.classList.remove('show'), 2500);
    }

    function showOnly(...visibleSections) {
        const all = [loadingState, errorState, noWalletState, selectMentorState, emptyState, noResultsState, studentsList];
        all.forEach((section) => {
            if (section) section.classList.toggle('hidden', !visibleSections.includes(section));
        });
    }

    function getActiveUserId() {
        return localStorage.getItem(ACTIVE_USER_ID_KEY);
    }

    // NEW — admin helpers
    function getAdminToken() {
        return localStorage.getItem(ADMIN_TOKEN_KEY);
    }

    function isAdminMode() {
        return !!getAdminToken();
    }

    // The id whose students we should actually be fetching: an admin's
    // selected محفظ takes priority over the device's own active wallet.
    function getEffectiveUserId() {
        return viewingUserId || getActiveUserId();
    }

    // NEW — the "add student" page has no localStorage access to an
    // admin's own wallet (it doesn't have one), so pass the currently
    // selected محفظ along explicitly via the URL.
    function buildAddStudentUrl() {
        const userId = getEffectiveUserId();
        return userId ? `add-student.html?userId=${encodeURIComponent(userId)}` : 'add-student.html';
    }

    // NEW — same idea for editing: carry both the studentId and the
    // owning محفظ's userId, so add-student.js's edit mode has a fallback
    // if the student fetch itself doesn't resolve an owner.
    function buildEditStudentUrl(studentId) {
        const userId = getEffectiveUserId();
        const params = new URLSearchParams({ id: studentId });
        if (userId) params.set('userId', userId);
        return `add-student.html?${params.toString()}`;
    }

    if (addStudentBtn) {
        addStudentBtn.addEventListener('click', () => {
            location.href = buildAddStudentUrl();
        });
    }

    // =====================================================================
    // API calls
    // =====================================================================
    async function fetchStudents(userId) {
        const res = await fetch(STUDENTS_ENDPOINT(userId));
        let json;
        try {
            json = await res.json();
        } catch (e) {
            throw new Error('استجابة غير صالحة من الخادم');
        }

        if (!res.ok || json.status !== 'success') {
            throw new Error(json.message || 'تعذر جلب بيانات الطلبة');
        }

        return Array.isArray(json.data) ? json.data : [];
    }

    async function fetchStudentById(studentId) {
        const token = getAdminToken();
        const res = await fetch(STUDENT_BY_ID_ENDPOINT(studentId), {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        let json;
        try {
            json = await res.json();
        } catch (e) {
            throw new Error('استجابة غير صالحة من الخادم');
        }

        if (!res.ok || json.status !== 'success') {
            throw new Error(json.message || 'تعذر جلب بيانات الطالب');
        }

        return json.data;
    }

    // NEW — click-on-student fetch, routed by whether an admin token exists:
    //   - admin token found  -> GET /students/:id directly (authenticated)
    //   - no admin token     -> no direct-by-id access; pull the student out
    //                           of the user-scoped GET /students/:userId list
    // TODO: confirm whether STUDENT_BY_ID_ENDPOINT actually requires an
    // admin token on your backend, or if it's open to any caller — if it's
    // open, the "no token" branch below could just call fetchStudentById too.
    async function fetchStudentDetails(studentId) {
        if (getAdminToken()) {
            return fetchStudentById(studentId);
        }

        const userId = getEffectiveUserId();
        if (!userId) {
            throw new Error('لا يوجد محفظ نشط');
        }

        const students = await fetchStudents(userId);
        const found = students.find((s) => s._id === studentId);
        if (!found) {
            throw new Error('تعذر العثور على بيانات الطالب');
        }
        return found;
    }

    async function updateStudentRequest(payload) {
        const res = await fetch(UPDATE_STUDENT_ENDPOINT, {
            method: 'PUT', // change to 'PATCH' if that's what your router expects
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        let json;
        try {
            json = await res.json();
        } catch (e) {
            throw new Error('استجابة غير صالحة من الخادم');
        }

        if (!res.ok || json.status !== 'success') {
            throw new Error(json.message || 'تعذر تحديث بيانات الطالب');
        }

        return json.data;
    }

    // NEW — move a student to another محفظ:
    // POST /students/editUser, Authorization: Bearer <admin token>,
    // body: { id: studentId, userId: targetUserId }.
    // Confirmed response: { status: 'success', message, code, data: { ...student } }
    async function moveStudentRequest(studentId, targetUserId) {
        const token = getAdminToken();
        const res = await fetch(MOVE_STUDENT_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ id: studentId, userId: targetUserId }),
        });

        let json;
        try {
            json = await res.json();
        } catch (e) {
            throw new Error('استجابة غير صالحة من الخادم');
        }

        if (!res.ok || json.status !== 'success') {
            throw new Error(json.message || 'تعذر نقل الطالب');
        }

        return json.data;
    }

    // NEW — GET /users/admin/getUsers with Authorization: Bearer <token>
    async function fetchAdminUsers() {
        const token = getAdminToken();
        const res = await fetch(ADMIN_USERS_ENDPOINT, {
            headers: { Authorization: `Bearer ${token}` },
        });

        let json;
        try {
            json = await res.json();
        } catch (e) {
            throw new Error('استجابة غير صالحة من الخادم');
        }

        if (!res.ok || json.status !== 'success') {
            throw new Error(json.message || 'تعذر جلب قائمة المحفظين');
        }
        let reportsLinkBtn = document.querySelectorAll('.reports-btn');
        reportsLinkBtn.forEach(e => {
            e.href = 'reports-admin.html';
        })

        return Array.isArray(json.data) ? json.data : [];
    }

    // =====================================================================
    // Delete dialog
    // =====================================================================
    function openDeleteDialog(studentId, studentName) {
        pendingDeleteId = studentId;
        deleteStudentName.textContent = studentName;
        deleteOverlay.classList.remove('hidden');
    }

    function closeDeleteDialog() {
        pendingDeleteId = null;
        deleteOverlay.classList.add('hidden');
    }

    cancelDeleteBtn.addEventListener('click', closeDeleteDialog);
    deleteOverlay.addEventListener('click', (e) => {
        if (e.target === deleteOverlay) closeDeleteDialog();
    });

    confirmDeleteBtn.addEventListener('click', async () => {
        if (!pendingDeleteId) return;

        confirmDeleteBtn.disabled = true;
        confirmDeleteBtn.innerHTML = `<span class="spinner show" style="border-color:rgba(255,255,255,0.4);border-top-color:#fff;width:16px;height:16px;border-width:2px"></span>`;

        try {
            const res = await fetch(`${API_BASE_URL}/students/${pendingDeleteId}`, {
                method: 'DELETE',
            });
            const json = await res.json();

            if (!res.ok || json.status !== 'success') {
                throw new Error(json.message || 'تعذر حذف الطالب');
            }

            closeDeleteDialog();
            showToast('تم حذف الطالب بنجاح', 'success');
            load();
        } catch (err) {
            showToast(err.message || 'حدث خطأ أثناء الحذف', 'error');
        } finally {
            confirmDeleteBtn.disabled = false;
            confirmDeleteBtn.innerHTML = `<span class="material-symbols-outlined text-base">delete</span> حذف`;
        }
    });

    // =====================================================================
    // Edit dialog
    // =====================================================================
    let pendingEditId = null;

    function setEditFormDisabled(disabled) {
        [editNameInput, editParentInput, editPhoneInput, editAgeInput, editGenderSelect].forEach((el) => {
            if (el) el.disabled = disabled;
        });
        if (confirmEditBtn) confirmEditBtn.disabled = disabled;
    }

    function fillEditForm(studentData) {
        editIdInput.value = studentData._id || '';
        editNameInput.value = studentData.name || '';
        editParentInput.value = studentData.parent_name || '';
        editPhoneInput.value = studentData.phone_number || '';
        editAgeInput.value = typeof studentData.age === 'number' ? studentData.age : '';
        if (editGenderSelect) editGenderSelect.value = studentData.gender || '';
    }

    async function openEditDialog(studentId) {
        pendingEditId = studentId;
        editOverlay.classList.remove('hidden');
        setEditFormDisabled(true);
        if (editLoading) editLoading.classList.remove('hidden');

        try {
            const studentData = await fetchStudentDetails(studentId);
            fillEditForm(studentData);
        } catch (err) {
            showToast(err.message || 'تعذر جلب بيانات الطالب', 'error');
            closeEditDialog();
        } finally {
            setEditFormDisabled(false);
            if (editLoading) editLoading.classList.add('hidden');
        }
    }

    function closeEditDialog() {
        pendingEditId = null;
        editOverlay.classList.add('hidden');
        if (editForm) editForm.reset();
    }

    if (cancelEditBtn) cancelEditBtn.addEventListener('click', closeEditDialog);
    if (editOverlay) {
        editOverlay.addEventListener('click', (e) => {
            if (e.target === editOverlay) closeEditDialog();
        });
    }

    if (editForm) {
        editForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!pendingEditId) return;

            const ageValue = editAgeInput.value.trim();
            const payload = {
                id: pendingEditId,
                name: editNameInput.value.trim(),
                parent_name: editParentInput.value.trim(),
                phone_number: editPhoneInput.value.trim(),
                gender: editGenderSelect ? editGenderSelect.value : undefined,
                age: ageValue ? Number(ageValue) : undefined,
            };

            confirmEditBtn.disabled = true;
            const originalBtnHtml = confirmEditBtn.innerHTML;
            confirmEditBtn.innerHTML = `<span class="spinner show" style="border-color:rgba(255,255,255,0.4);border-top-color:#fff;width:16px;height:16px;border-width:2px"></span>`;

            try {
                await updateStudentRequest(payload);
                closeEditDialog();
                showToast('تم تحديث بيانات الطالب بنجاح', 'success');
                load();
            } catch (err) {
                showToast(err.message || 'حدث خطأ أثناء التحديث', 'error');
            } finally {
                confirmEditBtn.disabled = false;
                confirmEditBtn.innerHTML = originalBtnHtml;
            }
        });
    }

    // =====================================================================
    // Move-to-another-محفظ dialog (admin only)
    // =====================================================================
    function openMoveDialog(studentId, studentName) {
        pendingMoveId = studentId;
        moveStudentNameEl.textContent = studentName;

        const currentOwner = getEffectiveUserId();
        moveTargetSelect.innerHTML = adminUsers
            .filter((u) => u._id !== currentOwner)
            .map((u) => `<option value="${escapeHtml(u._id)}">${escapeHtml(u.name)}</option>`)
            .join('');

        moveOverlay.classList.remove('hidden');
    }

    function closeMoveDialog() {
        pendingMoveId = null;
        moveOverlay.classList.add('hidden');
    }

    if (cancelMoveBtn) cancelMoveBtn.addEventListener('click', closeMoveDialog);
    if (moveOverlay) {
        moveOverlay.addEventListener('click', (e) => {
            if (e.target === moveOverlay) closeMoveDialog();
        });
    }

    if (confirmMoveBtn) {
        confirmMoveBtn.addEventListener('click', async () => {
            if (!pendingMoveId) return;
            const targetUserId = moveTargetSelect.value;
            if (!targetUserId) {
                showToast('اختر المحفظ الذي تريد نقل الطالب إليه', 'error');
                return;
            }

            confirmMoveBtn.disabled = true;
            const original = confirmMoveBtn.innerHTML;
            confirmMoveBtn.innerHTML = `<span class="spinner show" style="border-color:rgba(255,255,255,0.4);border-top-color:#fff;width:16px;height:16px;border-width:2px"></span>`;

            try {
                await moveStudentRequest(pendingMoveId, targetUserId);
                closeMoveDialog();
                showToast('تم نقل الطالب بنجاح', 'success');
                load();
            } catch (err) {
                showToast(err.message || 'حدث خطأ أثناء النقل', 'error');
            } finally {
                confirmMoveBtn.disabled = false;
                confirmMoveBtn.innerHTML = original;
            }
        });
    }

    // Single delegated click listener for edit / delete / move buttons.
    studentsList.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.delete-btn');
        if (deleteBtn) {
            const card = deleteBtn.closest('.student-card');
            const studentName = card.querySelector('.student-name').textContent;
            openDeleteDialog(deleteBtn.dataset.id, studentName);
            return;
        }

        const editBtn = e.target.closest('.edit-btn');
        if (editBtn) {
            // NEW — same fix as the add-student button: navigate to the
            // edit page with the studentId AND the owning محفظ's userId,
            // so add-student.js doesn't hit "لا يوجد محفظ نشط" for admins
            // (who have no active_user_id of their own in localStorage).
            location.href = buildEditStudentUrl(editBtn.dataset.id);
            return;
        }

        const moveBtn = e.target.closest('.move-btn');
        if (moveBtn) {
            const card = moveBtn.closest('.student-card');
            const studentName = card.querySelector('.student-name').textContent;
            openMoveDialog(moveBtn.dataset.id, studentName);
        }
    });

    // =====================================================================
    // NEW — Admin panel: list محفظين, click one to view their students
    // =====================================================================
    function renderAdminUsers(users) {
        adminUsersListEl.innerHTML = users.map((u) => `
            <button type="button" class="admin-user-chip" data-id="${escapeHtml(u._id)}">
                ${escapeHtml(u.name)}
            </button>
        `).join('');
    }

    if (adminUsersListEl) {
        adminUsersListEl.addEventListener('click', (e) => {
            const chip = e.target.closest('.admin-user-chip');
            if (!chip) return;

            viewingUserId = chip.dataset.id;
            document.querySelectorAll('.admin-user-chip').forEach((b) => {
                b.classList.toggle('active', b === chip);
            });

            load();
        });
    }

    async function initAdminPanel() {
        if (!isAdminMode()) {
            if (adminPanel) adminPanel.classList.add('hidden');
            return;
        }

        if (adminPanel) adminPanel.classList.remove('hidden');

        try {
            adminUsers = await fetchAdminUsers();
            renderAdminUsers(adminUsers);
        } catch (err) {
            showToast(err.message || 'تعذر تحميل قائمة المحفظين', 'error');
        }
    }

    // =====================================================================
    // Rendering
    // =====================================================================
    function renderStudentCard(student) {
        const name = student.name || 'بدون اسم';
        const gender = student.gender || '';
        const isFemale = gender === 'أنثى';
        const parentName = student.parent_name || '';
        const phone = student.phone_number || '';
        const age = student.age;

        return `
            <div class="student-card" data-name="${escapeHtml(name)}" data-parent="${escapeHtml(parentName)}">
                <div class="student-avatar ${isFemale ? 'female' : ''}">${escapeHtml(getInitials(name))}</div>
                <div class="student-info">
                    <div class="student-name">${escapeHtml(name)}</div>
                    <div class="student-meta">
                        ${parentName ? `<span><span class="material-symbols-outlined">supervisor_account</span>${escapeHtml(parentName)}</span>` : ''}
                        ${gender ? `<span><span class="material-symbols-outlined">wc</span>${escapeHtml(gender)}</span>` : ''}
                        ${phone ? `<span><span class="material-symbols-outlined">call</span>${escapeHtml(phone)}</span>` : ''}
                    </div>
                </div>
                ${typeof age === 'number' ? `<span class="age-badge">${age} سنة</span>` : ''}
                <button class="edit-btn" data-id="${escapeHtml(student._id)}" title="تعديل الطالب">
                    <span class="material-symbols-outlined">edit</span>
                </button>
                ${isAdminMode() ? `
                <button class="move-btn" data-id="${escapeHtml(student._id)}" title="نقل الطالب لمحفظ آخر">
                    <span class="material-symbols-outlined">move_up</span>
                </button>` : ''}
                <button class="delete-btn" data-id="${escapeHtml(student._id)}" title="حذف الطالب">
                    <span class="material-symbols-outlined">delete</span>
                </button>
            </div>
        `;
    }

    function renderList(students) {
        if (students.length === 0) {
            showOnly(noResultsState);
            return;
        }
        studentsList.innerHTML = students.map(renderStudentCard).join('');
        showOnly(studentsList);
    }

    function applySearch() {
        const query = searchInput.value.trim().toLowerCase();
        if (!query) {
            renderList(allStudents);
            return;
        }
        const filtered = allStudents.filter((s) => {
            const name = (s.name || '').toLowerCase();
            const parent = (s.parent_name || '').toLowerCase();
            return name.includes(query) || parent.includes(query);
        });
        renderList(filtered);
    }

    // =====================================================================
    // Load flow
    // =====================================================================
    async function load() {
        const userId = getEffectiveUserId();

        if (!userId) {
            searchSection.classList.add('hidden');

            if (isAdminMode()) {
                // Admin is logged in but hasn't picked a محفظ yet.
                headerSubtitle.textContent = 'اختر محفظاً';
                sideName.textContent = 'لوحة الإدارة';
                countSubtitle.textContent = '—';
                showOnly(selectMentorState);
            } else {
                headerSubtitle.textContent = 'غير مسجل';
                sideName.textContent = '—';
                countSubtitle.textContent = '—';
                showOnly(noWalletState);
            }
            return;
        }

        searchSection.classList.remove('hidden');
        showOnly(loadingState);

        // While viewing as admin, show whose students these are.
        if (isAdminMode() && viewingUserId) {
            const owner = adminUsers.find((u) => u._id === viewingUserId);
            if (owner) sideName.textContent = owner.name;
        }

        try {
            const students = await fetchStudents(userId);
            allStudents = students;

            countSubtitle.textContent = `${students.length} طالب مسجَّل`;
            headerSubtitle.textContent = `${students.length} طالب`;

            if (students.length === 0) {
                showOnly(emptyState);
                return;
            }

            applySearch();
        } catch (err) {
            errorMessage.textContent = err.message || 'حدث خطأ غير متوقع، حاول مرة أخرى.';
            showOnly(errorState);
        }
    }

    // =====================================================================
    // Events
    // =====================================================================
    if (searchInput)       searchInput.addEventListener('input', applySearch);
    if (retryBtn)          retryBtn.addEventListener('click', load);
    if (refreshBtnDesktop) refreshBtnDesktop.addEventListener('click', () => {
        load().then(() => showToast('تم التحديث', 'success'));
    });
    if (refreshBtnMobile)  refreshBtnMobile.addEventListener('click', () => {
        load().then(() => showToast('تم التحديث', 'success'));
    });

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) load();
    });

    initAdminPanel().then(load);
})();
