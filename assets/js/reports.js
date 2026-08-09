(function () {
  "use strict";

    const API_BASE = "https://masjid-nodejs-production.up.railway.app/api";

  // Read once at startup; guarded before first use inside DOMContentLoaded
  const userId = localStorage.getItem("active_user_id");
  const testId = localStorage.getItem("active_test_id");

  // Assigned inside DOMContentLoaded so the DOM is guaranteed to exist
  let mainContent = null;
  let attendanceChart = null;
  let currentRange = null;       // { from, to }
  let activeController = null;   // AbortController — cancels stale requests on re-fetch

  // ---------- helpers ----------

  function authHeaders(json = true) {
    const h = {};
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  // ISO "YYYY-MM-DD" in UTC — the only format the backend reliably parses as midnight.
  function isoDate(d = new Date()) {
    return d.toISOString().slice(0, 10);
  }

  function daysAgoIsoDate(n) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return isoDate(d);
  }

  // ---------- toast ----------

  function showToast(message, type = "error") {
    const existing = document.getElementById("app-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "app-toast";
    toast.setAttribute("role", "alert");
    toast.setAttribute("aria-live", "assertive");
    const bg =
      type === "error"
        ? "bg-error text-on-error"
        : "bg-secondary text-white";
    toast.className = `fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium ${bg} transition-opacity duration-300`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // ---------- API calls ----------

  async function fetchAttendanceReport(from, to, signal) {
    const res = await fetch(`${API_BASE}/reports`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ userId, from, to }),
      signal,
    });
    const json = await res.json();
    if (!res.ok || json.status !== "success") {
      throw new Error(json.message || "تعذر تحميل تقرير الحضور");
    }
    return json.data; // { present, absent, late, excused }
  }

  // testId is module-level; no need to pass it as a parameter
  async function fetchTestResults(signal) {
    const res = await fetch(`${API_BASE}/tests/${testId}`, {
      headers: authHeaders(false), // GET — no body, no Content-Type
      signal,
    });
    const json = await res.json();
    if (!res.ok || json.status !== "success") {
      throw new Error(json.message || "تعذر تحميل نتائج التقييم");
    }
    return json.data; // [{ totalDegree, student_id, name }]
  }

  async function downloadReportExcel(from, to) {
    const res = await fetch(`${API_BASE}/reports/download`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ userId, from, to }),
    });

    if (!res.ok) {
      let message = "تعذر تنزيل ملف إكسل";
      try {
        const json = await res.json();
        message = json.message || message;
      } catch (_) {
        /* response wasn't JSON — keep default message */
      }
      throw new Error(message);
    }

    const blob = await res.blob();

    let filename = `report-${from}_${to}.xlsx`;
    const disposition = res.headers.get("Content-Disposition");
    if (disposition) {
      // Prefer RFC 5987 encoded filename* over plain filename
      const match =
        disposition.match(/filename\*=UTF-8''([^;]+)/i) ||
        disposition.match(/filename="?([^";]+)"?/i);
      if (match?.[1]) filename = decodeURIComponent(match[1].trim());
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ---------- rendering ----------

  function renderStatCardSkeletons() {
    return Array.from(
      { length: 4 },
      () => `
        <div class="stat-card bg-surface-container rounded-2xl p-4 animate-pulse">
          <div class="h-6 w-6 rounded-full bg-outline-variant mb-2"></div>
          <div class="h-8 w-16 rounded bg-outline-variant mb-1"></div>
          <div class="h-3 w-12 rounded bg-outline-variant"></div>
        </div>`
    ).join("");
  }

  function renderLayout() {
    mainContent.innerHTML = `
      <div class="flex items-center justify-between mb-6 fade-in flex-wrap gap-4">
        <div>
          <h2 class="text-2xl font-bold text-primary">تقرير الفترة</h2>
          <p class="text-sm text-on-surface-variant" id="reportDateLabel"></p>
        </div>
        <div class="flex items-center gap-2 flex-wrap justify-end">
          <div class="flex items-center gap-1">
            <label for="fromPicker" class="text-xs text-on-surface-variant whitespace-nowrap">من</label>
            <input type="date" id="fromPicker"
              class="border border-outline-variant rounded-lg px-3 py-2 text-sm bg-surface-container text-on-surface" />
          </div>
          <div class="flex items-center gap-1">
            <label for="toPicker" class="text-xs text-on-surface-variant whitespace-nowrap">إلى</label>
            <input type="date" id="toPicker"
              class="border border-outline-variant rounded-lg px-3 py-2 text-sm bg-surface-container text-on-surface" />
          </div>
          <button id="applyRangeBtn"
            class="bg-secondary text-white px-3 py-2 rounded-lg text-sm font-bold hover:opacity-90 transition-opacity">
            تطبيق
          </button>
          <button id="exportBtn"
            class="no-print flex items-center gap-2 bg-primary text-on-primary px-4 py-2 rounded-lg text-sm font-bold hover:opacity-90 transition-opacity">
            <span class="spinner" id="exportSpinner" aria-hidden="true"></span>
            <span class="material-symbols-outlined text-base" id="exportIcon" aria-hidden="true">download</span>
            <span class="hidden md:inline">تصدير إكسل</span>
          </button>
        </div>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8" id="statCards" aria-live="polite">
        ${renderStatCardSkeletons()}
      </div>

      <div class="bg-surface-container rounded-2xl p-5 mb-8 fade-in">
        <h3 class="font-bold text-primary mb-4">توزيع الحضور</h3>
        <div class="flex flex-col md:flex-row items-center gap-6">
          <div class="w-48 h-48 shrink-0">
            <canvas id="attendanceChart"
              role="img"
              aria-label="مخطط دائري يوضح توزيع الحضور"></canvas>
          </div>
          <div class="flex-1 w-full" id="attendanceLegend" aria-hidden="true"></div>
        </div>
      </div>

      <div class="bg-surface-container rounded-2xl p-5 fade-in">
        <h3 class="font-bold text-primary mb-4">نتائج التقييم</h3>
        <div id="testResultsContainer" aria-live="polite">
          <div class="flex justify-center py-6" role="status" aria-label="جارٍ التحميل">
            <span class="material-symbols-outlined text-2xl text-outline animate-spin" aria-hidden="true">progress_activity</span>
          </div>
        </div>
      </div>
    `;
  }

  const STAT_CONFIG = {
    present: { label: "حاضر",   icon: "check_circle", color: "success"   },
    late:    { label: "متأخر",  icon: "schedule",     color: "warning"   },
    excused: { label: "مستأذن", icon: "info",         color: "secondary" },
    absent:  { label: "غائب",   icon: "cancel",       color: "error"     },
  };

  // Confirm the real passing threshold with the backend — 50 is a placeholder
  const PASS_THRESHOLD = 50;

  function renderStatCards(data) {
    const total =
      (Math.round(data.present) || 0) +
      (Math.round(data.absent)  || 0) +
      (Math.round(data.late)    || 0) +
      (Math.round(data.excused) || 0);

    const container = document.getElementById("statCards");
    container.innerHTML = Object.keys(STAT_CONFIG)
      .map((key) => {
        const cfg   = STAT_CONFIG[key];
        const value = Math.round(data[key]) || 0;
        const pct   = total ? Math.round((value / total) * 100) : 0;
        return `
          <div class="stat-card bg-surface-container rounded-2xl p-4 fade-in">
            <div class="flex items-center justify-between mb-2">
              <span class="material-symbols-outlined text-${cfg.color}" aria-hidden="true">${cfg.icon}</span>
              <span class="text-xs text-on-surface-variant">${pct}%</span>
            </div>
            <p class="text-2xl font-extrabold text-primary">${value}</p>
            <p class="text-xs text-on-surface-variant mt-1">${cfg.label}</p>
          </div>
        `;
      })
      .join("");
  }

  function renderChart(data) {
    const canvas = document.getElementById("attendanceChart");
    const labels = ["حاضر", "متأخر", "مستأذن", "غائب"];
    const values = [
      Math.round(data.present) || 0,
      Math.round(data.late)    || 0,
      Math.round(data.excused) || 0,
      Math.round(data.absent)  || 0,
    ];
    const colors = ["#1E7D45", "#E67E22", "#C9A23A", "#BA1A1A"];
    const total  = values.reduce((a, b) => a + b, 0);

    if (attendanceChart) attendanceChart.destroy();
    attendanceChart = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }],
      },
      options: {
        cutout: "70%",
        plugins: { legend: { display: false } },
      },
    });

    const legend = document.getElementById("attendanceLegend");
    legend.innerHTML = labels
      .map((label, i) => {
        const value = values[i];
        const pct   = total ? Math.round((value / total) * 100) : 0;
        return `
          <div class="flex items-center justify-between py-2 border-b border-outline-variant/50 last:border-0">
            <div class="flex items-center gap-2">
              <span class="legend-dot" style="background:${colors[i]}"></span>
              <span class="text-sm text-on-surface">${label}</span>
            </div>
            <div class="flex items-center gap-3 w-1/2">
              <div class="analysis-bar flex-1">
                <div style="width:${pct}%; background:${colors[i]}"></div>
              </div>
              <span class="text-xs text-on-surface-variant w-14 text-left">${value} (${pct}%)</span>
            </div>
          </div>
        `;
      })
      .join("");
  }

  function renderTestResults(students) {
    const container = document.getElementById("testResultsContainer");

    if (!students || !students.length) {
      container.innerHTML = `
        <div class="empty-state flex flex-col items-center justify-center py-8 text-center">
          <span class="material-symbols-outlined text-4xl text-outline mb-2" aria-hidden="true">quiz</span>
          <p class="text-sm text-on-surface-variant">لا توجد نتائج تقييم بعد</p>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="overflow-x-auto">
        <table class="w-full text-sm" aria-label="نتائج الطلاب">
          <caption class="sr-only">نتائج تقييم الطلاب</caption>
          <thead>
            <tr class="text-on-surface-variant text-xs border-b border-outline-variant">
              <th scope="col" class="text-right py-2 font-medium">الطالب</th>
              <th scope="col" class="text-right py-2 font-medium">الدرجة</th>
              <th scope="col" class="text-right py-2 font-medium">الحالة</th>
            </tr>
          </thead>
          <tbody>
            ${students
              .map((s) => {
                const passed = s.totalDegree >= PASS_THRESHOLD;
                return `
                  <tr class="student-row border-b border-outline-variant/50">
                    <td class="py-3">${s.name}</td>
                    <td class="py-3 font-bold text-primary">${s.totalDegree}</td>
                    <td class="py-3">
                      <span class="status-pill ${passed ? "present" : "absent"}">
                        ${passed ? "ناجح" : "راسب"}
                      </span>
                    </td>
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  // Shown when the attendance fetch itself fails — replaces the stat cards grid
  function renderAttendanceError(message, from, to) {
    const container = document.getElementById("statCards");
    container.innerHTML = `
      <div class="col-span-2 md:col-span-4 flex flex-col items-center justify-center py-8 text-center" role="alert">
        <span class="material-symbols-outlined text-3xl text-error mb-2" aria-hidden="true">error</span>
        <p class="text-on-surface font-medium text-sm">${message}</p>
        <button id="retryAttendanceBtn"
          class="mt-3 bg-primary text-on-primary px-4 py-2 rounded-lg text-sm">
          إعادة المحاولة
        </button>
      </div>
    `;
    document
      .getElementById("retryAttendanceBtn")
      ?.addEventListener("click", () => loadAll(from, to));
  }

  // ---------- export button ----------

  function wireExportButton(button, { spinner, icon } = {}) {
    if (!button) return;
    button.addEventListener("click", async () => {
      if (!currentRange || button.disabled) return;
      button.disabled = true;
      if (spinner) spinner.classList.add("show");
      if (icon) icon.style.display = "none";
      try {
        await downloadReportExcel(currentRange.from, currentRange.to);
      } catch (err) {
        console.error(err);
        showToast(err.message);
      } finally {
        button.disabled = false;
        if (spinner) spinner.classList.remove("show");
        if (icon) icon.style.display = "";
      }
    });
  }

  // ---------- orchestration ----------

  async function loadAll(from, to) {
    // Cancel any in-flight requests from a previous call
    if (activeController) activeController.abort();
    activeController = new AbortController();
    const { signal } = activeController;

    currentRange = { from, to };
    renderLayout();

    document.getElementById("reportDateLabel").textContent = `${from} — ${to}`;

    const fromPicker = document.getElementById("fromPicker");
    const toPicker   = document.getElementById("toPicker");
    fromPicker.value = from;
    toPicker.value   = to;

    // renderLayout() recreates the DOM each call, so listeners are always fresh
    document.getElementById("applyRangeBtn").addEventListener("click", () => {
      const f = fromPicker.value;
      const t = toPicker.value;
      if (f && t && f <= t) loadAll(f, t);
    });

    wireExportButton(document.getElementById("exportBtn"), {
      spinner: document.getElementById("exportSpinner"),
      icon:    document.getElementById("exportIcon"),
    });

    // Attendance report
    try {
      const attendance = await fetchAttendanceReport(from, to, signal);
      renderStatCards(attendance);
      renderChart(attendance);
    } catch (err) {
      if (err.name === "AbortError") return; // superseded by a newer loadAll call
      console.error(err);
      renderAttendanceError(err.message, from, to);
    }

    // Test results
    try {
      const students = await fetchTestResults(signal);
      renderTestResults(students);
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error(err);
      document.getElementById("testResultsContainer").innerHTML =
        `<p class="text-error text-sm" role="alert">${err.message}</p>`;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    mainContent = document.getElementById("mainContent");

    // Guard: both IDs must be present before making any API calls
    if (!userId || !testId) {
      mainContent.innerHTML = `
        <div class="flex-1 flex flex-col items-center justify-center text-center py-12" role="alert">
          <span class="material-symbols-outlined text-4xl text-error mb-3" aria-hidden="true">lock</span>
          <p class="text-on-surface font-medium">جلسة غير صالحة، يرجى إعادة تسجيل الدخول</p>
        </div>
      `;
      return;
    }

    // Default range: last 7 days → today
    loadAll(daysAgoIsoDate(7), isoDate());

    // Static export button in the mobile header (outside #mainContent — wired once)
    document.getElementById("exportBtnMobile")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (!currentRange || btn.disabled) return;
      btn.disabled = true;
      try {
        await downloadReportExcel(currentRange.from, currentRange.to);
      } catch (err) {
        console.error(err);
        showToast(err.message);
      } finally {
        btn.disabled = false;
      }
    });
  });
})();
