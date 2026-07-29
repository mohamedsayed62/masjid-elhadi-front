(function () {
  const API_BASE_URL = 'https://masjid-nodejs-production.up.railway.app/api';
  const STUDENTS_ENDPOINT = `${API_BASE_URL}/students`;
  const ACTIVE_USER_ID_KEY = 'active_user_id';

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

  // Clear invalid on input
  nameInput.addEventListener('input',   () => setInvalid(nameShell,   nameError,   false));
  parentInput.addEventListener('input', () => setInvalid(parentShell, parentError, false));
  phoneInput.addEventListener('input',  () => setInvalid(phoneShell,  phoneError,  false));
  ageInput.addEventListener('input',    () => setInvalid(ageShell,    ageError,    false));

  // ── Submit ──
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const userId     = localStorage.getItem(ACTIVE_USER_ID_KEY);
    const name       = nameInput.value.trim();
    const gender     = document.querySelector('input[name="gender"]:checked')?.value || '';
    const parentName = parentInput.value.trim();
    const phone      = phoneInput.value.trim();
    const age        = parseInt(ageInput.value);

    // Validate
    let hasError = false;

    if (!userId) {
      showToast('لا يوجد محفظ نشط، يرجى تسجيل الدخول', 'error');
      setTimeout(() => location.href = 'index.html', 1500);
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
      const res = await fetch(STUDENTS_ENDPOINT, {
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

      const json = await res.json();

      if (!res.ok || json.status !== 'success') {
        throw new Error(json.message || 'تعذر حفظ بيانات الطالب');
      }

      showToast('تمت إضافة الطالب بنجاح', 'success');
      setTimeout(() => location.href = 'students.html', 900);

    } catch (err) {
      showToast(err.message || 'حدث خطأ أثناء الحفظ', 'error');
    } finally {
      saveBtn.disabled = false;
      btnSpinner.classList.remove('show');
      btnLabel.textContent = 'حفظ الطالب';
    }
  });
})();