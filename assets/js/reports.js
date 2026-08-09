(function () {
  "use strict";

  const API_BASE = "https://masjid-nodejs-production.up.railway.app/api";

  const userId = localStorage.getItem("active_user_id");
  const testId = localStorage.getItem("active_test_id");

  const mainContent = document.getElementById("mainContent");
  let attendanceChart = null;
  let currentRange = null; // { from, to }

  // ---------- helpers ----------

  /**
   * Returns fetch headers that always include the Bearer token.
   * Pass json = false for GET requests that send no body.
   */
  function authHeaders(json = true) {
    const h = {};
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  // ISO "YYYY-MM-DD" — the only format the backend reliably parses as UTC midnight.
  function isoDate(d = new Date()) {
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ].join("-");
  }

  function daysAgoIsoDate(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return isoDate(d);
  }

  // ---------- API calls ----------

  async function fetchAttendanceReport(from, to) {
    const res = await fetch(`${API_BASE}/reports`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ userId, from, to }),
    });
    const json = await res.json();
    if (!res.ok || json.status !== "success") {
      throw new Error(json.message || "تعذر تحميل تقرير الحضور");
    }
    return json.data; // { present, absent, late, excused }
  }

  async function fetchTestResults(id) {
    const res = await fetch(`${API_BASE}/tests/${id}`, {
      headers: authHeaders(false), // GET — no body, no Content-Type
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
      const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      if (match?.[1]) filename = decodeURIComponent(match[1]);
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

  function renderLayout() {
    mainContent.innerHTML = `
      <div class="flex items-center justify-between mb-6 fade-in flex-wrap gap-4">
        <div>
          <h2 class="text-2xl font-bold text-primary">تقرير الفترة</h2>
          <p class="text-sm text-on-surface-variant" id="reportDateLabel"></p>
        </div>
        <div class="flex items-center gap-2 flex-wrap justify-end">
          <div class="flex items-center gap-1">
            <label class="text-xs text-on-surface-variant whitespace-nowrap">من</label>
            <input type="date" id="fromPicker"
              class="border border-outline-variant rounded-lg px-3 py-2 text-sm bg-surface-container text-on-surface" />
          </div>
          <div class="flex items-center gap-1">
            <label class="text-xs text-on-surface-variant whitespace-nowrap">إلى</label>
            <input type="date" id="toPicker"
              class="border border-outline-variant rounded-lg px-3 py-2 text-sm bg-surface-container text-on-surface" />
          </div>
          <button id="applyRangeBtn"
            class="bg-secondary text-white px-3 py-2 rounded-lg text-sm font-bold hover:opacity-90 transition-opacity">
            تطبيق
          </button>
          <button id="exportBtn"
            class="no-print flex items-center gap-2 bg-primary text-on-primary px-4 py-2 rounded-lg text-sm font-bold hover:opacity-90 transition-opacity">
            <span class="spinner" id="exportSpinner"></span>
            <span class="material-symbols-outlined text-base" id="exportIcon">download</span>
            <span class="hidden md:inline">تصدير إكسل</span>
          </button>
        </div>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8" id="statCards"></div>

      <div class="bg-surface-container rounded-2xl p-5 mb-8 fade-in">
        <h3 class="font-bold text-primary mb-4">توزيع الحضور</h3>
        <div class="flex flex-col md:flex-row items-center gap-6">
          <div class="w-48 h-48 shrink-0"><canvas id="attendanceChart"></canvas></div>
          <div class="flex-1 w-full" id="attendanceLegend"></div>
        </div>
      </div>

      <div class="bg-surface-container rounded-2xl p-5 fade-in">
        <h3 class="font-bold text-primary mb-4">نتائج التقييم</h3>
        <div id="testResultsContainer">
          <div class="flex justify-center py-6">
            <span class="material-symbols-outlined text-2xl text-outline animate-spin">progress_activity</span>
          </div>
        </div>
      </div>
    `;
  }

  const STAT_CONFIG = {
    present:  { label: "حاضر",    icon: "check_circle", color: "success"   },
    late:     { label: "متأخر",   icon: "schedule",     color: "warning"   },
    excused:  { label: "مستأذن", icon: "info",          color: "secondary" },
    absent:   { label: "غائب",    icon: "cancel",       color: "error"     },
  };

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
              <span class="material-symbols-outlined text-${cfg.color}">${cfg.icon}</span>
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
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }] },
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
              <div class="analysis-bar flex-1"><div style="width:${pct}%; background:${colors[i]}"></div></div>
              <span class="text-xs text-on-surface-variant w-14 text-left">${value} (${pct}%)</span>
            </div>
          </div>
        `;
      })
      .join("");
  }

  // TODO: confirm the real passing threshold with the backend — 50 is a placeholder
  const PASS_THRESHOLD = 50;

  function renderTestResults(students) {
    const container = document.getElementById("testResultsContainer");

    if (!students || !students.length) {
      container.innerHTML = `
        <div class="empty-state flex flex-col items-center justify-center py-8 text-center">
          <span class="material-symbols-outlined text-4xl text-outline mb-2">quiz</span>
          <p class="text-sm text-on-surface-variant">لا توجد نتائج تقييم بعد</p>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-on-surface-variant text-xs border-b border-outline-variant">
              <th class="text-right py-2 font-medium">الطالب</th>
              <th class="text-right py-2 font-medium">الدرجة</th>
              <th class="text-right py-2 font-medium">الحالة</th>
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

  function renderFatalError(message, from, to) {
    mainContent.innerHTML = `
      <div class="flex-1 flex flex-col items-center justify-center text-center py-12">
        <span class="material-symbols-outlined text-4xl text-error mb-3">error</span>
        <p class="text-on-surface font-medium">${message}</p>
        <button id="retryBtn" class="mt-4 bg-primary text-on-primary px-4 py-2 rounded-lg text-sm">إعادة المحاولة</button>
      </div>
    `;
    document.getElementById("retryBtn").addEventListener("click", () => loadAll(from, to));
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
        alert(err.message);
      } finally {
        button.disabled = false;
        if (spinner) spinner.classList.remove("show");
        if (icon) icon.style.display = "";
      }
    });
  }

  // ---------- orchestration ----------

  async function loadAll(from, to) {
    currentRange = { from, to };
    renderLayout();

    document.getElementById("reportDateLabel").textContent = `${from} — ${to}`;

    const fromPicker = document.getElementById("fromPicker");
    const toPicker   = document.getElementById("toPicker");
    fromPicker.value = from;
    toPicker.value   = to;

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
      const attendance = await fetchAttendanceReport(from, to);
      renderStatCards(attendance);
      renderChart(attendance);
    } catch (err) {
      console.error(err);
      document.getElementById("statCards").innerHTML =
        `<p class="col-span-2 md:col-span-4 text-error text-sm">${err.message}</p>`;
    }

    // Test results
    try {
      const students = await fetchTestResults(testId);
      renderTestResults(students);
    } catch (err) {
      console.error(err);
      document.getElementById("testResultsContainer").innerHTML =
        `<p class="text-error text-sm">${err.message}</p>`;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
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
        alert(err.message);
      } finally {
        btn.disabled = false;
      }
    });
  });
})();
