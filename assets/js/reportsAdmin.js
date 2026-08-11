(function () {
  "use strict";

  const API_BASE = "https://masjid-nodejs-production.up.railway.app/api";

  const token = localStorage.getItem("admin_token");

  const mainContent = document.getElementById("mainContent");
  let attendanceChart = null;
  let currentFrom = null;
  let currentTo = null;

  // ---------- helpers ----------

  function isoDate(d) {
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  function defaultRange() {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 30);
    return { from: isoDate(from), to: isoDate(to) };
  }

  function authHeaders() {
    if (!token) return { "Content-Type": "application/json" };
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
  }

  function filenameFromDisposition(disposition, fallback) {
    if (!disposition) return fallback;
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    return match ? decodeURIComponent(match[1]) : fallback;
  }

  function extensionFromContentType(contentType) {
    if (!contentType) return "xlsx";
    if (contentType.includes("pdf")) return "pdf";
    if (contentType.includes("csv")) return "csv";
    if (contentType.includes("spreadsheet") || contentType.includes("excel")) return "xlsx";
    return "xlsx";
  }

  // ---------- API calls ----------

  async function fetchAdminReport(from, to) {
    const res = await fetch(`${API_BASE}/reports/admin`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ from, to }),
    });

    const json = await res.json();
    if (!res.ok || json.status !== "success") {
      throw new Error(json.message || "تعذر تحميل تقرير الحضور");
    }
    const percentages = json.data;
    return percentages || { present: 0, absent: 0, late: 0, excused: 0 };
  }

  async function downloadAdminReport(from, to) {
    const res = await fetch(`${API_BASE}/reports/download/admin`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ from, to }),
    });

    if (!res.ok) {
      let message = "تعذر تنزيل التقرير";
      try {
        const errJson = await res.json();
        message = errJson.message || message;
      } catch (_) {}
      throw new Error(message);
    }

    const blob = await res.blob();
    const contentType = res.headers.get("Content-Type");
    const disposition = res.headers.get("Content-Disposition");
    const fallbackName = `attendance-report-${from}-to-${to}.${extensionFromContentType(contentType)}`;
    const filename = filenameFromDisposition(disposition, fallbackName);

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  // ---------- rendering ----------

  function renderLayout() {
    mainContent.innerHTML = `
      <!-- ── Header + date pickers ───────────────────────────────────────── -->
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 fade-in">
        <div>
          <h2 class="text-2xl font-bold text-primary">تقرير الحضور العام</h2>
          <p class="text-sm text-on-surface-variant" id="reportRangeLabel"></p>
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          <label class="flex items-center gap-2 text-sm text-on-surface-variant">
            من
            <input type="date" id="fromPicker"
              class="border border-outline-variant rounded-lg px-3 py-2 text-sm bg-surface-container text-on-surface" />
          </label>
          <label class="flex items-center gap-2 text-sm text-on-surface-variant">
            إلى
            <input type="date" id="toPicker"
              class="border border-outline-variant rounded-lg px-3 py-2 text-sm bg-surface-container text-on-surface" />
          </label>
          <button id="refreshBtn"
            class="flex items-center gap-2 bg-primary text-on-primary px-4 py-2 rounded-lg text-sm font-bold hover:opacity-90 transition-opacity">
            <span class="material-symbols-outlined text-base">refresh</span>
            <span class="hidden md:inline">تحديث</span>
          </button>
          <button id="downloadBtn"
            class="flex items-center gap-2 bg-secondary text-on-secondary-container px-4 py-2 rounded-lg text-sm font-bold hover:opacity-90 transition-opacity">
            <span class="material-symbols-outlined text-base">download</span>
            <span class="hidden md:inline">تحميل التقرير</span>
          </button>
        </div>
      </div>

      <!-- ── Stat cards ───────────────────────────────────────────────────── -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8" id="statCards"></div>

      <!-- ── Attendance chart ─────────────────────────────────────────────── -->
      <div class="bg-surface-container rounded-2xl p-5 fade-in mb-8">
        <h3 class="font-bold text-primary mb-4">توزيع الحضور</h3>
        <div class="flex flex-col md:flex-row items-center gap-6">
          <div class="w-48 h-48 shrink-0"><canvas id="attendanceChart"></canvas></div>
          <div class="flex-1 w-full" id="attendanceLegend"></div>
        </div>
      </div>

      <!-- ── Student degrees ──────────────────────────────────────────────── -->
      <div class="bg-surface-container rounded-2xl p-5 fade-in">
        <div class="flex items-center justify-between mb-5">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-secondary">leaderboard</span>
            <h3 class="font-bold text-primary">درجات الطلاب</h3>
          </div>
          <span class="text-xs text-on-surface-variant bg-surface-container-high
                        rounded-full px-3 py-1">
            مجموع الدرجات لكل طالب
          </span>
        </div>
        <!-- Skeleton/loaded cards go here -->
        <div class="flex flex-col gap-2" id="studentDegreesSection"></div>
      </div>
    `;
  }

  const STAT_CONFIG = {
    present:  { label: "حاضر",    icon: "check_circle", color: "success"   },
    late:     { label: "متأخر",   icon: "schedule",     color: "warning"   },
    excused:  { label: "مستأذن",  icon: "info",         color: "secondary" },
    absent:   { label: "غائب",    icon: "cancel",       color: "error"     },
  };

  function renderStatCards(percentages) {
    const container = document.getElementById("statCards");
    container.innerHTML = Object.keys(STAT_CONFIG)
      .map((key) => {
        const cfg = STAT_CONFIG[key];
        const pct = Math.round(percentages[key] || 0);
        return `
          <div class="stat-card bg-surface-container rounded-2xl p-4 fade-in">
            <div class="flex items-center justify-between mb-2">
              <span class="material-symbols-outlined text-${cfg.color}">${cfg.icon}</span>
            </div>
            <p class="text-2xl font-extrabold text-primary">${pct}%</p>
            <p class="text-xs text-on-surface-variant mt-1">${cfg.label}</p>
          </div>`;
      })
      .join("");
  }

  function renderChart(percentages) {
    const canvas = document.getElementById("attendanceChart");
    const labels = ["حاضر", "متأخر", "مستأذن", "غائب"];
    const values = [
      Math.round(percentages.present  || 0),
      Math.round(percentages.late     || 0),
      Math.round(percentages.excused  || 0),
      Math.round(percentages.absent   || 0),
    ];
    const colors = ["#1E7D45", "#E67E22", "#C9A23A", "#BA1A1A"];

    if (attendanceChart) attendanceChart.destroy();
    attendanceChart = new Chart(canvas, {
      type: "doughnut",
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }] },
      options: {
        cutout: "70%",
        plugins: { legend: { display: false } },
      },
    });

    const legend = document.getElementById("attendanceLegend");
    legend.innerHTML = labels
      .map((label, i) => {
        const pct = values[i];
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
              <span class="text-xs text-on-surface-variant w-14 text-left">${pct}%</span>
            </div>
          </div>`;
      })
      .join("");
  }

  function renderFatalError(message) {
    mainContent.innerHTML = `
      <div class="flex-1 flex flex-col items-center justify-center text-center py-12">
        <span class="material-symbols-outlined text-4xl text-error mb-3">error</span>
        <p class="text-on-surface font-medium">${message}</p>
        <button id="retryBtn"
          class="mt-4 bg-primary text-on-primary px-4 py-2 rounded-lg text-sm">
          إعادة المحاولة
        </button>
      </div>`;
    document.getElementById("retryBtn")
      .addEventListener("click", () => loadAll(currentFrom, currentTo));
  }

  function showToast(message, isError) {
    const toast = document.createElement("div");
    toast.textContent = message;
    toast.className = `fixed bottom-6 inset-x-0 mx-auto w-fit max-w-[90%] px-4 py-2
      rounded-lg text-sm shadow-lg z-50 ${isError ? "bg-error text-white" : "bg-primary text-on-primary"}`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  }

  // ---------- orchestration ----------

  async function loadAll(from, to) {
    currentFrom = from;
    currentTo   = to;

    if (!token) {
      renderFatalError("لا يوجد رمز دخول (Bearer token). الرجاء تسجيل الدخول كمسؤول أولاً.");
      return;
    }

    renderLayout();
    document.getElementById("reportRangeLabel").textContent = `${from} → ${to}`;

    const fromPicker = document.getElementById("fromPicker");
    const toPicker   = document.getElementById("toPicker");
    fromPicker.value = from;
    toPicker.value   = to;

    document.getElementById("refreshBtn").addEventListener("click", () => {
      loadAll(fromPicker.value || from, toPicker.value || to);
    });

    const downloadBtn = document.getElementById("downloadBtn");
    downloadBtn.addEventListener("click", async () => {
      const dlFrom = fromPicker.value || currentFrom;
      const dlTo   = toPicker.value   || currentTo;

      downloadBtn.disabled = true;
      const originalHTML = downloadBtn.innerHTML;
      downloadBtn.innerHTML = `
        <span class="material-symbols-outlined text-base animate-spin">progress_activity</span>
        <span class="hidden md:inline">جاري التحميل...</span>`;

      try {
        await downloadAdminReport(dlFrom, dlTo);
      } catch (err) {
        console.error(err);
        showToast(err.message, true);
      } finally {
        downloadBtn.disabled    = false;
        downloadBtn.innerHTML   = originalHTML;
      }
    });

    // ── Attendance report (existing) ────────────────────────────────────────
    try {
      const percentages = await fetchAdminReport(from, to);
      renderStatCards(percentages);
      renderChart(percentages);
    } catch (err) {
      console.error(err);
      renderFatalError(err.message);
      return;  // don't load degrees if the page itself failed
    }

    // ── Student degrees (new) ───────────────────────────────────────────────
    // TestsAPI is defined in testsApi.js, loaded before this file.
    if (window.TestsAPI) {
      window.TestsAPI.loadStudentDegrees();
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const { from, to } = defaultRange();
    loadAll(from, to);
  });
})();
