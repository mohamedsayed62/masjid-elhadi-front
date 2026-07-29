(function () {
  // =====================================================================
  // CONFIG — replace with your real API base URL and endpoints
  // =====================================================================
  const API_BASE_URL = 'https://masjid-nodejs-production.up.railway.app/api'; // TODO: set real base URL
  const CREATE_ENDPOINT = `${API_BASE_URL}/users`;       // TODO: replace with your real "create/login" endpoint
  const GET_USER_ENDPOINT = (id) => `${API_BASE_URL}/users/${id}`; // TODO: confirm route shape

  // We now ONLY keep the user's id in localStorage. No name/date is cached
  // locally — the display name always comes fresh from the API response.
  const ACTIVE_USER_ID_KEY = 'active_user_id';

  // =====================================================================
  // DOM references
  // =====================================================================
  const checkingState = document.getElementById('checkingState');
  const welcomeState = document.getElementById('welcomeState');
  const formState = document.getElementById('formState');
  const welcomeName = document.getElementById('welcomeName');
  const continueBtn = document.getElementById('continueBtn');
  const logoutBtn = document.getElementById('logoutBtn');

  const form = document.getElementById('walletForm');
  const nameInput = document.getElementById('sessionName');
  const dateInput = document.getElementById('startDate');
  const nameShell = document.getElementById('nameShell');
  const dateShell = document.getElementById('dateShell');
  const nameError = document.getElementById('nameError');
  const dateError = document.getElementById('dateError');
  const saveBtn = document.getElementById('saveBtn');
  const btnSpinner = document.getElementById('btnSpinner');
  const btnLabel = document.getElementById('btnLabel');
  const toast = document.getElementById('toast');

  // default date = today
  const today = new Date().toISOString().split('T')[0];
  dateInput.value = today;

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
  // localStorage — id only
  // =====================================================================
  function getActiveUserId() {
    return localStorage.getItem(ACTIVE_USER_ID_KEY);
  }

  function setActiveUserId(id) {
    localStorage.setItem(ACTIVE_USER_ID_KEY, String(id));
  }

  function clearActiveUserId() {
    localStorage.removeItem(ACTIVE_USER_ID_KEY);
  }

  // =====================================================================
  // API calls
  // =====================================================================

  // Fetches the user by id and returns the parsed `data` object,
  // matching this response shape:
  // { status: "success", message: "...", code: 200, data: { _id, name, __v } }
  async function fetchUserById(id) {
    const res = await fetch(GET_USER_ENDPOINT(id));
    const json = await res.json();

    if (!res.ok || json.status !== 'success' || !json.data) {
      throw new Error(json.message || 'تعذر جلب بيانات المستخدم');
    }

    return json.data; // { _id, name, __v }
  }

  // Creates a wallet/user on the server. Adjust the body to match your
  // real endpoint's expected payload.
  async function createWallet(name, startDate) {
    const res = await fetch(CREATE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const json = await res.json();

    if (!res.ok || json.status !== 'success' || !json.data) {
      throw new Error(json.message || 'تعذر حفظ البيانات');
    }

    return json.data; // { _id, name, __v }
  }

  // =====================================================================
  // Render returning-user state using the API response
  // =====================================================================
  function renderWelcome(userData) {
    welcomeName.textContent = `مرحباً بك، ${escapeHtml(userData.name)}`;
    showOnly(welcomeState);
  }

  // =====================================================================
  // Boot: check if we already have an id, otherwise show the form
  // =====================================================================
  async function init() {
    const existingId = getActiveUserId();

    if (!existingId) {
      showOnly(formState);
      return;
    }

    showOnly(checkingState);

    try {
      const userData = await fetchUserById(existingId);
      window.location.href = 'students.html';
    } catch (err) {
      // id is stale/invalid on the server — clear it and fall back to the form
      clearActiveUserId();
      showToast('يرجى تسجيل الدخول مرة أخرى', 'error');
      showOnly(formState);
    }
  }

  // =====================================================================
  // Events — returning user screen
  // =====================================================================
  continueBtn.addEventListener('click', () => {
    window.location.href = 'students.html';
  });

  logoutBtn.addEventListener('click', () => {
    clearActiveUserId();
    showOnly(formState);
  });

  // =====================================================================
  // Events — registration form
  // =====================================================================
  nameInput.addEventListener('input', () => {
    if (nameInput.value.trim().length > 0) {
      setInvalid(nameShell, nameError, false);
    }
  });

  dateInput.addEventListener('input', () => {
    if (dateInput.value.length > 0) {
      setInvalid(dateShell, dateError, false);
    }
  });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const name = nameInput.value.trim();

    const nameInvalid = name.length === 0;

    setInvalid(nameShell, nameError, nameInvalid);

    if (nameInvalid) {
      showToast('يرجى تعبئة جميع الحقول المطلوبة', 'error');
      return;
    }

    saveBtn.disabled = true;
    btnSpinner.classList.add('show');
    btnLabel.textContent = 'جاري الحفظ...';

    try {
      const userData = await createWallet(name);

      // Only the id is persisted locally
      setActiveUserId(userData._id);

      showToast('تم حفظ المحفظ بنجاح', 'success');
      setTimeout(() => {
        window.location.href = 'students.html';
      }, 900);
    } catch (err) {
      showToast(err.message || 'حدث خطأ أثناء الحفظ', 'error');
    } finally {
      saveBtn.disabled = false;
      btnSpinner.classList.remove('show');
      btnLabel.textContent = 'حفظ وبدء الاستخدام';
    }
  });

  init();
})();