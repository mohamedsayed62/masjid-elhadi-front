(function () {
  const API_BASE_URL = 'https://masjid-nodejs-production.up.railway.app/api';
  const STUDENTS_ENDPOINT = `${API_BASE_URL}/students`; // POST target for creating a student

  // NEW — GET /students/:userId — lists all students for one محفظ. Used to
  // pull a single student's data by scanning this list (see note below).
  const STUDENTS_BY_USER_ENDPOINT = (userId) => `${API_BASE_URL}/students/${userId}`;

  // NEW — same by-id route students.js reads a single student from.
  const STUDENT_BY_ID_ENDPOINT = (studentId) => `${API_BASE_URL}/students/${studentId}`;

  // NEW — updateStudent reads req.body.id (not the URL), matching students.js.
  const UPDATE_STUDENT_ENDPOINT = `${API_BASE_URL}/students`;

  const ACTIVE_USER_ID_KEY = 'active_user_id';

  // NEW — must match the key used in students.js.
  const ADMIN_TOKEN_KEY = 'admin_token';

  // NEW — edit mode is triggered by an ?id=<studentId> query param, e.g.
  // add-student.html?id=6a6f... . No param = normal "create" mode.
  const pageParams = new URLSearchParams(location.search);
  const editingStudentId = pageParams.get('id');

  // NEW — which محفظ this page is for, when opened by an admin. An admin
  // has no active_user_id of their own, so students.js must pass the
  // selected محفظ's id explicitly, e.g. add-student.html?userId=<id> or
  // add-student.html?id=<studentId>&userId=<ownerId>.
  const targetUserIdParam = pageParams.get('userId');

  let editingStudentUserId = null; // the student's current owner, filled in once fetched

  // ── DOM ──
  const form         = document.getElementById('studentForm');
  const nameInput    = document.getElementById('name');
  const parentInput  = document.getElementById('parent_name');
  const phoneInput   = document.getElementById('phone_number');
  const ageInput     = document.getElementById('age');
  const saveBtn      = document.getElementById('saveBtn');
  const btnSpinner   = document.getElementById('btnSpinner');
  const btnLabel     = document.getElementById('btnLabel');
  const toast        = document.getElementById('toast');

  const nameShell    = document.getElementById('nameShell');
  const parentShell  = document.getElementById('parentShell');
  const phoneShell   = document.getElementById('phoneShell');
  const ageShell     = document.getElementById('ageShell');

  const nameError    = document.getElementById('nameError');
  const parentError  = document.getElementById('parentError');
  const phoneError   = document.getElementById('phoneError');
  const ageError     = document.getElementById('ageError');
  const genderError  = document.getElementById('genderError');

  const maleOption   = document.getElementById('maleOption');
  const femaleOption = document.getElementById('femaleOption');
  const genderGroup  = document.querySelector('.gender-group');

  // ── Gender selection ──
  document.querySelectorAll('input[name="gender"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      maleOption.classList.toggle('selected', radio.value === 'ذكر' && radio.checked);
      femaleOption.classList.toggle('selected', radio.value === 'أنثى' && radio.checked);
      genderGroup.classList.remove('invalid');
      genderError.classList.remove('show');
    });
  });

  // ── Helpers ──
  function showToast(message, type) {
    toast.textContent = message;
    toast.className = 'toast show' + (type ? ' ' + type : '');
    setTimeout(() => toast.classList.remove('show'), 2500);
  }

  function setInvalid(shell, errorEl, invalid) {
    shell.classList.toggle('invalid', invalid);
    errorEl.classList.toggle('show', invalid);
  }

  // NEW — admin helper, same pattern as students.js
  function getAdminToken() {
    return localStorage.getItem(ADMIN_TOKEN_KEY);
  }

  // NEW — check a radio button and let the existing 'change' listener
  // above handle the .selected styling, instead of duplicating it here.
  function setGender(value) {
    const radio = document.querySelector(`input[name="gender"][value="${value}"]`);
    if (radio) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change'));
    }
  }

  function setFormDisabled(disabled) {
    [nameInput, parentInput, phoneInput, ageInput].forEach((el) => { el.disabled = disabled; });
    document.querySelectorAll('input[name="gender"]').forEach((el) => { el.disabled = disabled; });
    saveBtn.disabled = disabled;
  }

  // Clear invalid on input
  nameInput.addEventListener('input',   () => setInvalid(nameShell,   nameError,   false));
  parentInput.addEventListener('input', () => setInvalid(parentShell, parentError, false));
  phoneInput.addEventListener('input',  () => setInvalid(phoneShell,  phoneError,  false));
  ageInput.addEventListener('input',    () => setInvalid(ageShell,    ageError,    false));

  // =====================================================================
  // NEW — Edit mode: fetch the existing student and prefill the form.
  //
  // IMPORTANT: STUDENTS_BY_USER_ENDPOINT (`/students/:userId`) and
  // STUDENT_BY_ID_ENDPOINT (`/students/:studentId`) are the SAME URL
  // shape on this backend, and the handler behind that route always does
  // `user.findById(req.params.id)` first — it expects a محفظ/user id, not
  // a student id. Calling it with a student id returns "المستخدم غير
  // موجود" (user not found). So instead of fetching the student directly,
  // we fetch the full student list for its known owner and pick it out
  // client-side — the same safe approach students.js already falls back
  // to for non-admin users.
  // =====================================================================
  async function loadStudentForEdit(studentId, ownerUserId) {
    setFormDisabled(true);
    if (btnLabel) btnLabel.textContent = 'جارِ التحميل...';

    try {
      if (!ownerUserId) {
        throw new Error('لم يتم تحديد المحفظ صاحب الطالب');
      }

      const res = await fetch(STUDENTS_BY_USER_ENDPOINT(ownerUserId));

      let json;
      try {
        json = await res.json();
      } catch (e) {
        throw new Error('استجابة غير صالحة من الخادم');
      }

      if (!res.ok || json.status !== 'success') {
        throw new Error(json.message || 'تعذر جلب بيانات الطالب');
      }

      const list = Array.isArray(json.data) ? json.data : [];
      const student = list.find((s) => s._id === studentId);
      if (!student) {
        throw new Error('تعذر العثور على بيانات الطالب');
      }

      editingStudentUserId = ownerUserId;

      nameInput.value = student.name || '';
      parentInput.value = student.parent_name || '';
      phoneInput.value = student.phone_number || '';
      ageInput.value = typeof student.age === 'number' ? student.age : '';
      if (student.gender) setGender(student.gender);
    } catch (err) {
      showToast(err.message || 'تعذر تحميل بيانات الطالب', 'error');
    } finally {
      setFormDisabled(false);
      if (btnLabel) btnLabel.textContent = 'حفظ التعديلات';
    }
  }

  if (editingStudentId) {
    // Prefer the ?userId= carried in the link; fall back to this device's
    // own wallet for the non-admin case.
    const ownerForEdit = targetUserIdParam || localStorage.getItem(ACTIVE_USER_ID_KEY);
    loadStudentForEdit(editingStudentId, ownerForEdit);
  }

  // ── Submit ──
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const name       = nameInput.value.trim();
    const gender     = document.querySelector('input[name="gender"]:checked')?.value || '';
    const parentName = parentInput.value.trim();
    const phone      = phoneInput.value.trim();
    const age        = parseInt(ageInput.value);

    // NEW — resolve which محفظ (userId) this student belongs to:
    //   - editing + admin token found  -> keep the student's own userId
    //     (an admin editing someone else's student shouldn't reassign it),
    //     falling back to the ?userId= param if the fetch hasn't resolved it
    //   - editing + no admin token     -> fall back to this device's wallet
    //   - creating, admin token found  -> the ?userId= param (the محفظ the
    //     admin had selected on students.html when they hit "add student")
    //   - creating, no admin token     -> this device's own wallet
    let userId;
    if (editingStudentId) {
      userId = getAdminToken()
        ? (editingStudentUserId || targetUserIdParam)
        : localStorage.getItem(ACTIVE_USER_ID_KEY);
    } else {
      userId = getAdminToken() ? targetUserIdParam : localStorage.getItem(ACTIVE_USER_ID_KEY);
    }

    // Validate
    let hasError = false;

    if (!userId) {
      if (getAdminToken()) {
        // Admin opened this page without a ?userId= — nothing to attach
        // the student to. Send them back to pick a محفظ first.
        showToast('لم يتم تحديد المحفظ، الرجاء العودة واختيار محفظ أولاً', 'error');
        setTimeout(() => location.href = 'students.html', 1500);
      } else {
        showToast('لا يوجد محفظ نشط، يرجى تسجيل الدخول', 'error');
        setTimeout(() => location.href = 'index.html', 1500);
      }
      return;
    }

    if (!name)       { setInvalid(nameShell,   nameError,   true); hasError = true; }
    if (!gender)     { genderGroup.classList.add('invalid'); genderError.classList.add('show'); hasError = true; }
    if (!parentName) { setInvalid(parentShell, parentError, true); hasError = true; }
    if (!phone)      { setInvalid(phoneShell,  phoneError,  true); hasError = true; }
    if (!age || age < 1) { setInvalid(ageShell, ageError,   true); hasError = true; }

    if (hasError) {
      showToast('يرجى تعبئة جميع الحقول المطلوبة', 'error');
      return;
    }

    // Submit
    saveBtn.disabled = true;
    btnSpinner.classList.add('show');
    btnLabel.textContent = 'جاري الحفظ...';

    try {
      let res;
      if (editingStudentId) {
        // NEW — edit: PUT with the id inside the body, matching
        // updateStudent's findOneAndUpdate({ _id: req.body.id }, ...).
        res = await fetch(UPDATE_STUDENT_ENDPOINT, {
          method: 'PUT', // change to 'PATCH' if that's what your router expects
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: editingStudentId,
            userId,
            name,
            gender,
            parent_name: parentName,
            phone_number: phone,
            age,
          }),
        });
      } else {
        res = await fetch(STUDENTS_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId,
            name,
            gender,
            parent_name: parentName,
            phone_number: phone,
            age,
          }),
        });
      }

      const json = await res.json();

      if (!res.ok || json.status !== 'success') {
        throw new Error(json.message || 'تعذر حفظ بيانات الطالب');
      }

      showToast(editingStudentId ? 'تم تحديث بيانات الطالب بنجاح' : 'تمت إضافة الطالب بنجاح', 'success');
      setTimeout(() => location.href = 'students.html', 900);

    } catch (err) {
      showToast(err.message || 'حدث خطأ أثناء الحفظ', 'error');
    } finally {
      saveBtn.disabled = false;
      btnSpinner.classList.remove('show');
      btnLabel.textContent = editingStudentId ? 'حفظ التعديلات' : 'حفظ الطالب';
    }
  });
})();
