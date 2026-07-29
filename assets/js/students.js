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

    // Only the id is ever read from localStorage — same key the login
    // screen writes. Nothing about the students themselves is cached.
    const ACTIVE_USER_ID_KEY = 'active_user_id';

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

    const retryBtn = document.getElementById('retryBtn');
    const refreshBtnDesktop = document.getElementById('refreshBtnDesktop');
    const refreshBtnMobile = document.getElementById('refreshBtnMobile');
    const toast = document.getElementById('toast');

    const deleteOverlay     = document.getElementById('deleteOverlay');
    const deleteStudentName = document.getElementById('deleteStudentName');
    const cancelDeleteBtn   = document.getElementById('cancelDeleteBtn');
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
    let pendingDeleteId = null;

    // --- Edit dialog DOM refs -------------------------------------------
    // NOTE: these elements don't exist in the HTML you shared yet.
    // See the markup snippet at the end of this file — add it next to
    // your delete overlay markup.
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
    const editLoading       = document.getElementById('editLoading'); // optional spinner over the form

    let allStudents = [];

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
        const all = [loadingState, errorState, noWalletState, emptyState, noResultsState, studentsList];
        all.forEach((section) => {
            if (section) section.classList.toggle('hidden', !visibleSections.includes(section));
        });
    }

    function getActiveUserId() {
        return localStorage.getItem(ACTIVE_USER_ID_KEY);
    }

    // =====================================================================
    // API calls
    // =====================================================================
    // Handles the response shape:
    // { status: "success", message: "...", code: 200, data: [ {student...} ] }
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

        // data is an array of student records
        return Array.isArray(json.data) ? json.data : [];
    }

    // Matches getStudent: GET /students/:id -> { status, message, code, data: {student} }
    async function fetchStudentById(studentId) {
        const res = await fetch(STUDENT_BY_ID_ENDPOINT(studentId));
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

    // Matches updateStudent: id must be in the BODY (req.body.id), since the
    // handler does findOneAndUpdate({ _id: req.body.id }, { ...req.body }).
    // Whatever keys you send become the $set-style overwrite fields here
    // (it's a plain object merge via ...req.body, not $set, so make sure
    // you send the full set of fields you want to keep).
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

    // =====================================================================
    // Delete dialog
    // =====================================================================
    let pendingDeleteId2 = null; // (kept name distinct, see original pendingDeleteId above)

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

            const cached = allStudents.find((s) => s._id === studentId);
            const studentData = cached || (await fetchStudentById(studentId));
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
                id: pendingEditId, // updateStudent reads req.body.id
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

    // Single delegated click listener for BOTH edit and delete buttons.
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
            openEditDialog(editBtn.dataset.id);
        }
    });

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
        const userId = getActiveUserId();

        if (!userId) {
            headerSubtitle.textContent = 'غير مسجل';
            sideName.textContent = '—';
            countSubtitle.textContent = '—';
            searchSection.classList.add('hidden');
            showOnly(noWalletState);
            return;
        }

        searchSection.classList.remove('hidden');
        showOnly(loadingState);

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

    load();
})();

/* =========================================================================
   HTML you need to add (mirrors your existing #deleteOverlay markup).
   Place it next to the delete overlay in your HTML file.
   =========================================================================

<div id="editOverlay" class="overlay hidden">
  <div class="dialog">
    <h3>تعديل بيانات الطالب</h3>
    <form id="editForm">
      <input type="hidden" id="editId">

      <label>
        الاسم
        <input type="text" id="editName" required>
      </label>

      <label>
        اسم ولي الأمر
        <input type="text" id="editParentName">
      </label>

      <label>
        رقم الهاتف
        <input type="tel" id="editPhone">
      </label>

      <label>
        العمر
        <input type="number" id="editAge" min="0">
      </label>

      <label>
        الجنس
        <select id="editGender">
          <option value="">—</option>
          <option value="ذكر">ذكر</option>
          <option value="أنثى">أنثى</option>
        </select>
      </label>

      <div id="editLoading" class="hidden">جارِ التحميل...</div>

      <div class="dialog-actions">
        <button type="button" id="cancelEditBtn">إلغاء</button>
        <button type="submit" id="confirmEditBtn">
          <span class="material-symbols-outlined text-base">save</span> حفظ
        </button>
      </div>
    </form>
  </div>
</div>

========================================================================= */