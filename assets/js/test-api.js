/* assets/js/testsApi.js
   Handles GET /api/tests and renders the "top students by degree" section.
   Depends on: admin_token in localStorage.
   Exposes: window.TestsAPI.loadStudentDegrees()
*/
window.TestsAPI = (function () {
  "use strict";

  const API_BASE = "https://masjid-nodejs-production.up.railway.app/api";

  // ── helpers ────────────────────────────────────────────────────────────────

  function authHeaders() {
    const token = localStorage.getItem("admin_token");
    return {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async function fetchTests() {
  const res = await fetch(`${API_BASE}/tests`, {
    method: "GET",
    headers: authHeaders(),
  });

  // API returns a plain array, not { status, data }
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.message || "تعذر تحميل بيانات الاختبارات");
  }

  // Handle both shapes: plain array OR { data: [...] }
  return Array.isArray(json) ? json : (json.data || []);
}

  // ── aggregation ────────────────────────────────────────────────────────────

  // Groups raw test records by student, summing their degrees.
  // Returns an array sorted by totalDegree descending.
  function aggregateByStudent(tests) {
    const map = {};
    for (const t of tests) {
      const student = t.student_id;
      if (!student) continue;
      const id = student._id || student;
      if (!map[id]) {
        map[id] = {
          id,
          name: student.name || "—",
          student_code: student.student_id || "",
          totalDegree: 0,
          testCount: 0,
        };
      }
      map[id].totalDegree += t.degree || 0;
      map[id].testCount += 1;
    }
    return Object.values(map).sort((a, b) => b.totalDegree - a.totalDegree);
  }

// ── rendering ──────────────────────────────────────────────────────────────

function renderStudentDegrees(students) {
  const section = document.getElementById("studentDegreesSection");
  if (!section) return;

  if (!students.length) {
    section.innerHTML = `
      <p class="text-center text-on-surface-variant text-sm py-10">
        لا توجد بيانات اختبارات حتى الآن
      </p>`;
    return;
  }

  const maxDegree = students[0].totalDegree || 1;

  section.innerHTML = students
    .map((s, i) => {
      // API already returns { totalDegree, name } — no aggregation needed
      const pct  = Math.round((s.totalDegree / maxDegree) * 100);
      const meta = medal(i);
      const rank = i + 1;

      const avatar = meta
        ? `<div class="w-10 h-10 rounded-full shrink-0 flex items-center justify-center ${meta.bg} ${meta.text}">
             <span class="material-symbols-outlined text-xl">${meta.icon}</span>
           </div>`
        : `<div class="w-10 h-10 rounded-full shrink-0 flex items-center justify-center
                       bg-surface-container-high text-on-surface-variant font-bold text-sm">
             ${rank}
           </div>`;

      return `
        <div class="flex items-center gap-4 px-4 py-3
                    rounded-2xl bg-surface-container
                    hover:bg-surface-container-high transition-colors fade-in">
          ${avatar}
          <div class="flex-1 min-w-0">
            <p class="font-bold text-on-surface text-sm truncate">${s.name}</p>
            <div class="flex items-center gap-2 mt-1.5">
              <div class="analysis-bar flex-1">
                <div style="width:${pct}%; background:#0B1D3A"></div>
              </div>
            </div>
          </div>
          <div class="shrink-0 text-start min-w-[52px]">
            <p class="text-2xl font-extrabold text-primary leading-none">${s.totalDegree}</p>
            <p class="text-xs text-on-surface-variant mt-0.5">درجة</p>
          </div>
        </div>`;
    })
    .join("");
}

  function renderLoading() {
    const section = document.getElementById("studentDegreesSection");
    if (!section) return;
    section.innerHTML = `
      <div class="flex justify-center py-10">
        <span class="material-symbols-outlined text-3xl text-outline animate-spin">
          progress_activity
        </span>
      </div>`;
  }

  function renderError(message) {
    const section = document.getElementById("studentDegreesSection");
    if (!section) return;
    section.innerHTML = `
      <div class="flex flex-col items-center justify-center py-10 text-center gap-2">
        <span class="material-symbols-outlined text-3xl text-error">error</span>
        <p class="text-sm text-on-surface-variant">${message}</p>
        <button
          onclick="TestsAPI.loadStudentDegrees()"
          class="mt-1 text-xs bg-primary text-on-primary px-3 py-1.5 rounded-lg">
          إعادة المحاولة
        </button>
      </div>`;
  }

  // ── public ─────────────────────────────────────────────────────────────────

  async function loadStudentDegrees() {
  renderLoading();
  try {
    const students = await fetchTests(); // already aggregated by the backend
    renderStudentDegrees(students);
  } catch (err) {
    console.error("[TestsAPI]", err);
    renderError(err.message);
  }
}

  return { loadStudentDegrees };
})();
