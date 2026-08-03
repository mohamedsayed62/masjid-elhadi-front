(function () {
  // =====================================================================
  // CONFIG — replace with your real API base URL and endpoints
  // =====================================================================
  const API_BASE_URL = 'https://masjid-nodejs-production.up.railway.app/api';
  const LOGIN_ENDPOINT = `${API_BASE_URL}/users/admin`; // TODO: confirm real admin login route
  const VERIFY_ENDPOINT = `${API_BASE_URL}/users/admin`;    // TODO: confirm real "who am I" route (auth'd via Bearer token)

  // Only the token (plus a display name for the welcome screen) is cached
  // locally. Nothing sensitive like the password is ever stored.
  const ADMIN_TOKEN_KEY = 'admin_token';
  const ADMIN_NAME_KEY = 'admin_name';

  // =====================================================================
  // DOM references
  // =====================================================================
  const checkingState = document.getElementById('checkingState');
  const welcomeState = document.getElementById('welcomeState');
  const formState = document.getElementById('formState');
  const welcomeName = document.getElementById('welcomeName');
  const continueBtn = document.getElementById('continueBtn');
  const logoutBtn = document.getElementById('logoutBtn');

  const form = document.getElementById('loginForm');
  const nameInput = document.getElementById('adminName');
  const passwordInput = document.getElementById('adminPassword');
  const nameShell = document.getElementById('nameShell');
  const passwordShell = document.getElementById('passwordShell');
  const nameError = document.getElementById('nameError');
  const passwordError = document.getElementById('passwordError');
  const saveBtn = document.getElementById('saveBtn');
  const btnSpinner = document.getElementById('btnSpinner');
  const btnLabel = document.getElementById('btnLabel');
  const toast = document.getElementById('toast');

  // =====================================================================
  // UI helpers
  // =====================================================================
  function showToast(message, type) {
    toast.textContent = message;
    toast.className = 'toast show' + (type ? ' ' + type : '');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 2500);
  }

  function showOnly(el) {
    [checkingState, welcomeState, formState].forEach((section) => {
      section.classList.toggle('hidden', section !== el);
    });
  }

  function setInvalid(shell, errorEl, invalid) {
    shell.classList.toggle('invalid', invalid);
    errorEl.classList.toggle('show', invalid);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // =====================================================================
  // localStorage — token + display name only
  // =====================================================================
  function getToken() {
    return localStorage.getItem(ADMIN_TOKEN_KEY);
  }

  function setSession(token, name) {
    localStorage.setItem(ADMIN_TOKEN_KEY, token);
    if (name) localStorage.setItem(ADMIN_NAME_KEY, name);
  }

  function clearSession() {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    localStorage.removeItem(ADMIN_NAME_KEY);
  }

  // =====================================================================
  // API calls
  // =====================================================================

  // Logs the admin in. Expected response shape:
  // { status: "success", message: "...", code: 200,
  //   data: { _id, name, role, __v, token } }
  async function loginAdmin(name, password) {
    const res = await fetch(LOGIN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    });
    const json = await res.json();

    if (!res.ok || json.status !== 'success' || !json.data || !json.data.token) {
      throw new Error(json.message || 'تعذر تسجيل الدخول');
    }
    localStorage.removeItem('active_user_id'); 

    return json.data; // { _id, name, role, __v, token }
  }

  // Verifies an existing token is still valid and returns the admin's data.
  async function verifyToken(token) {
    const res = await fetch(VERIFY_ENDPOINT, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();

    if (!res.ok || json.status !== 'success' || !json.data) {
      throw new Error(json.message || 'الجلسة غير صالحة');
    }

    return json.data; // { _id, name, role, __v }
  }

  // =====================================================================
  // Render returning-admin state
  // =====================================================================
  function renderWelcome(name) {
    welcomeName.textContent = `مرحباً بك، ${escapeHtml(name)}`;
    showOnly(welcomeState);
  }

  // =====================================================================
  // Boot: check if we already have a token, otherwise show the form
  // =====================================================================
  async function init() {
    const existingToken = getToken();

    if (!existingToken) {
      showOnly(formState);
      return;
    }

    showOnly(checkingState);

    try {
      const adminData = await verifyToken(existingToken);
      setSession(existingToken, adminData.name);
      renderWelcome(adminData.name);
    } catch (err) {
      // token is stale/invalid on the server — clear it and fall back to the form
      clearSession();
      showToast('يرجى تسجيل الدخول مرة أخرى', 'error');
      showOnly(formState);
    }
  }

  // =====================================================================
  // Events — returning admin screen
  // =====================================================================
  continueBtn.addEventListener('click', () => {
    window.location.href = 'students.html';
  });

  logoutBtn.addEventListener('click', () => {
    clearSession();
    showOnly(formState);
  });

  // =====================================================================
  // Events — login form
  // =====================================================================
  nameInput.addEventListener('input', () => {
    if (nameInput.value.trim().length > 0) {
      setInvalid(nameShell, nameError, false);
    }
  });

  passwordInput.addEventListener('input', () => {
    if (passwordInput.value.length > 0) {
      setInvalid(passwordShell, passwordError, false);
    }
  });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const name = nameInput.value.trim();
    const password = passwordInput.value;

    const nameInvalid = name.length === 0;
    const passwordInvalid = password.length === 0;

    setInvalid(nameShell, nameError, nameInvalid);
    setInvalid(passwordShell, passwordError, passwordInvalid);

    if (nameInvalid || passwordInvalid) {
      showToast('يرجى تعبئة جميع الحقول المطلوبة', 'error');
      return;
    }

    saveBtn.disabled = true;
    btnSpinner.classList.add('show');
    btnLabel.textContent = 'جاري تسجيل الدخول...';

    try {
      const adminData = await loginAdmin(name, password);

      // Only the token (and a display name) are persisted locally
      setSession(adminData.token, adminData.name);

      showToast('تم تسجيل الدخول بنجاح', 'success');
      setTimeout(() => {
        window.location.href = 'students.html';
      }, 900);
    } catch (err) {
      showToast(err.message || 'حدث خطأ أثناء تسجيل الدخول', 'error');
    } finally {
      saveBtn.disabled = false;
      btnSpinner.classList.remove('show');
      btnLabel.textContent = 'تسجيل الدخول';
    }
  });

  init();
})();
