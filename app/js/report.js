const STATUS_LABELS = {
    success: "Выставлено",
    skipped: "Пропущено",
    no_data: "Нет данных",
    error: "Ошибка"
};

const VALID_STYLES = new Set(["calm", "swiss", "bw", "editorial"]);

let historyList = [];
let currentReport = null;

function pluralizeRu(n, one, few, many) {
    const abs = Math.abs(Number(n) || 0);
    const mod100 = abs % 100;
    if (mod100 >= 11 && mod100 <= 14) return many;
    const mod10 = abs % 10;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
}

function formatDate(iso) {
    return new Date(iso).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    });
}

function escapeHtml(str) {
    return String(str ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function applyReportStyle(style) {
    const valid = VALID_STYLES.has(style) ? style : "calm";
    document.documentElement.setAttribute("data-style", valid);
    const select = document.getElementById("styleSelect");
    if (select) select.value = valid;
}

function renderHistorySelect() {
    const select = document.getElementById("historySelect");
    if (!historyList.length) {
        select.innerHTML = `<option value="">Нет отчётов</option>`;
        return;
    }
    select.innerHTML = historyList.map((r, idx) => {
        const disputedCount = r.summary?.disputed ?? 0;
        const disputedWord = pluralizeRu(disputedCount, "спорный", "спорных", "спорных");
        const label = `${formatDate(r.createdAt)} · ${r.assistant}${disputedCount ? ` · ${disputedCount} ${disputedWord}` : ""}`;
        return `<option value="${idx}">${escapeHtml(label)}</option>`;
    }).join("");
}

function renderClassFilter() {
    const select = document.getElementById("classFilter");
    const classes = [...new Set((currentReport?.items || []).map(i => i.className || "Без названия"))];
    select.hidden = classes.length <= 1;
    select.innerHTML = `<option value="">Все классы (${classes.length})</option>` +
        classes.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
}

function renderReport() {
    const metaEl = document.getElementById("reportMeta");
    const summaryEl = document.getElementById("reportSummary");
    const contentEl = document.getElementById("reportContent");
    const onlyDisputed = document.getElementById("onlyDisputedToggle").checked;
    const selectedClass = document.getElementById("classFilter").value;

    if (!currentReport) {
        metaEl.textContent = "";
        summaryEl.innerHTML = "";
        contentEl.innerHTML = `<div class="empty-report">Сохранённых отчётов пока нет.</div>`;
        return;
    }

    const s = currentReport.summary || {};
    const modeLabel = currentReport.mode === "realtime" ? "В реальном времени" : "Фоновый режим";
    const stoppedLabel = currentReport.stopped ? " · остановлено" : "";
    metaEl.textContent = `${currentReport.assistant} · ${modeLabel} · ${formatDate(currentReport.createdAt)}${stoppedLabel}`;

    const classesCount = s.classes ?? 0;
    const disputedCount = s.disputed ?? 0;
    const classLabel = pluralizeRu(classesCount, "Класс", "Класса", "Классов");
    const disputedLabel = pluralizeRu(disputedCount, "Спорный", "Спорных", "Спорных");

    summaryEl.innerHTML = `
        <div class="stat-item"><span class="stat-value">${classesCount}</span><span class="stat-label">${classLabel}</span></div>
        <div class="stat-item"><span class="stat-value">${s.success ?? 0}</span><span class="stat-label">Выставлено</span></div>
        <div class="stat-item"><span class="stat-value">${s.skipped ?? 0}</span><span class="stat-label">Пропущено</span></div>
        <div class="stat-item"><span class="stat-value">${(s.noData ?? 0) + (s.errors ?? 0)}</span><span class="stat-label">Нет данных / ошибки</span></div>
        <div class="stat-item disputed"><span class="stat-value">${disputedCount}</span><span class="stat-label">${disputedLabel}</span></div>
    `;

    const items = (currentReport.items || []).filter(item => {
        if (onlyDisputed && !item.disputed) return false;
        if (selectedClass && (item.className || "Без названия") !== selectedClass) return false;
        return true;
    });

    if (!items.length) {
        contentEl.innerHTML = `<div class="empty-report">${onlyDisputed ? "Спорных записей в этом запуске нет." : "Нет записей для отображения."}</div>`;
        return;
    }

    const groups = new Map();
    for (const item of items) {
        const key = item.className || "Без названия";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }

    const isMultiClass = groups.size > 1;

    contentEl.innerHTML = Array.from(groups.entries()).map(([className, rows]) => {
        const rowDisputedCount = rows.filter(r => r.disputed).length;
        const isOpen = !isMultiClass || onlyDisputed || rowDisputedCount > 0;
        const rowDisputedWord = pluralizeRu(rowDisputedCount, "спорный", "спорных", "спорных");

        return `
            <details class="class-block" ${isOpen ? "open" : ""}>
                <summary class="class-header">
                    <span class="class-title">${escapeHtml(className)}</span>
                    <span class="class-meta">
                        ${rows.length} уч.${rowDisputedCount ? ` · <span class="text-disputed">${rowDisputedCount} ${rowDisputedWord}</span>` : ""}
                    </span>
                </summary>
                <div class="class-table-card">
                    <table class="report-table">
                        <thead>
                            <tr>
                                <th>Ученик</th>
                                <th>Статус</th>
                                <th class="num">Ср. балл</th>
                                <th class="num">Пропуски</th>
                                <th>Комментарий</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.map(row => {
                                const st = escapeHtml(row.status || "skipped");
                                const label = STATUS_LABELS[row.status] || st;
                                return `
                                    <tr class="${row.disputed ? "row-disputed" : ""}">
                                        <td class="student-cell">${escapeHtml(row.student)}</td>
                                        <td class="status-cell"><span class="status-dot st-${st}"></span><span>${escapeHtml(label)}</span></td>
                                        <td class="num">${row.avg != null ? escapeHtml(row.avg) : "—"}</td>
                                        <td class="num">${row.absencePct != null ? `${escapeHtml(row.absencePct)}%` : "—"}</td>
                                        <td class="note-cell">${escapeHtml(row.note || (row.disputed ? "Требует проверки" : "—"))}</td>
                                    </tr>
                                `;
                            }).join("")}
                        </tbody>
                    </table>
                </div>
            </details>
        `;
    }).join("");
}

async function init() {
    const data = await chrome.storage.local.get(["reportHistory", "settings", "reportStyle"]);
    const themeMode = data.settings?.themeMode;
    if (themeMode && themeMode !== "auto") {
        document.documentElement.setAttribute("data-theme", themeMode);
    }

    applyReportStyle(data.reportStyle || "calm");

    historyList = Array.isArray(data.reportHistory) ? data.reportHistory : [];
    currentReport = historyList[0] || null;

    renderHistorySelect();
    renderClassFilter();
    renderReport();

    document.getElementById("styleSelect").addEventListener("change", async (e) => {
        const nextStyle = e.target.value;
        applyReportStyle(nextStyle);
        await chrome.storage.local.set({ reportStyle: nextStyle });
    });

    document.getElementById("historySelect").addEventListener("change", (e) => {
        currentReport = historyList[Number(e.target.value)] || null;
        renderClassFilter();
        renderReport();
    });

    document.getElementById("classFilter").addEventListener("change", renderReport);
    document.getElementById("onlyDisputedToggle").addEventListener("change", renderReport);
    document.getElementById("printPdfBtn").addEventListener("click", () => window.print());
}

init();