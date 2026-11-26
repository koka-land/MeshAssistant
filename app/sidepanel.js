const DEFAULT_SETTINGS = {
    themeMode: "mesh",
    fontScaleStep: 0,
    highThreshold: 4.5,
    midThreshold: 3.5,
    lowThreshold: 2.5,
    absenceRatio: 0.5
};

const notClassJournalHint = document.getElementById("notClassJournalHint");
const assistantsAccordion = document.getElementById("assistantsAccordion");
const skillsControls = document.getElementById("skillsControls");
const fontScaleSlider = document.getElementById("fontScaleSlider");
const fontScaleBadge = document.getElementById("fontScaleBadge");

const themeAccordionBtn = document.getElementById("themeAccordionBtn");
const themeAccordionBody = document.getElementById("themeAccordionBody");
const fontAccordionBtn = document.getElementById("fontAccordionBtn");
const fontAccordionBody = document.getElementById("fontAccordionBody");
const thresholdsAccordionBtn = document.getElementById("thresholdsAccordionBtn");
const thresholdsAccordionBody = document.getElementById("thresholdsAccordionBody");
const schoolRulesAccordionBtn = document.getElementById("schoolRulesAccordionBtn");
const schoolRulesAccordionBody = document.getElementById("schoolRulesAccordionBody");

const schoolRulesElements = {
    metaEl: document.getElementById("schoolRulesMeta"),
    mark5El: document.getElementById("schoolRuleMark5"),
    mark4El: document.getElementById("schoolRuleMark4"),
    mark3El: document.getElementById("schoolRuleMark3"),
    mark2El: document.getElementById("schoolRuleMark2"),
    creditEl: document.getElementById("schoolRuleCredit"),
    interimEl: document.getElementById("schoolRuleInterim")
};

const darkSchemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
let currentThemeMode = "mesh";
let contextRetryTimer = null;
let isTaskRunning = false;
let isTaskPaused = false;
let lastAppliedClassJournal = null;

function openReportPage() {
    chrome.tabs.create({ url: chrome.runtime.getURL("report.html") });
}

async function refreshLastReportLink() {
    const section = document.getElementById("lastReportSection");
    const meta = document.getElementById("lastReportMeta");
    if (!section || !meta) return;

    const { reportHistory = [] } = await chrome.storage.local.get("reportHistory");
    const last = reportHistory[0];
    if (!last) {
        section.hidden = true;
        return;
    }

    const time = new Date(last.createdAt).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
    });
    const classes = last.summary?.classes ?? 0;
    const disputed = last.summary?.disputed ?? 0;
    meta.textContent = `${time} · классов: ${classes}${disputed ? ` · спорных: ${disputed}` : ""}`;
    section.hidden = false;
}

async function refreshSchoolRulesUI(rulesOverride = null) {
    if (!window.MeshJournalStatic) return;
    const rules = rulesOverride || await window.MeshJournalStatic.getSchoolMarkRules();
    window.MeshJournalStatic.renderSchoolMarkRulesToDom(rules, schoolRulesElements);
}

function setAccordionOpen(btn, body, open) {
    const isOpen = Boolean(open);
    btn?.setAttribute("aria-expanded", String(isOpen));
    body?.classList.toggle("open", isOpen);
}

themeAccordionBtn?.addEventListener("click", () => {
    const currentlyOpen = themeAccordionBtn.getAttribute("aria-expanded") === "true";
    setAccordionOpen(themeAccordionBtn, themeAccordionBody, !currentlyOpen);
});

fontAccordionBtn?.addEventListener("click", () => {
    const currentlyOpen = fontAccordionBtn.getAttribute("aria-expanded") === "true";
    setAccordionOpen(fontAccordionBtn, fontAccordionBody, !currentlyOpen);
});

thresholdsAccordionBtn?.addEventListener("click", () => {
    const currentlyOpen = thresholdsAccordionBtn.getAttribute("aria-expanded") === "true";
    setAccordionOpen(thresholdsAccordionBtn, thresholdsAccordionBody, !currentlyOpen);
});

schoolRulesAccordionBtn?.addEventListener("click", () => {
    const currentlyOpen = schoolRulesAccordionBtn.getAttribute("aria-expanded") === "true";
    setAccordionOpen(schoolRulesAccordionBtn, schoolRulesAccordionBody, !currentlyOpen);
});

function getStepDecimals(stepValue) {
    const str = String(stepValue);
    const dotIndex = str.indexOf(".");
    return dotIndex === -1 ? 0 : str.length - dotIndex - 1;
}

function syncStepperButtons(box) {
    const input = box.querySelector('input[type="number"]');
    const prevBtn = box.querySelector('[data-step-dir="-1"]');
    const nextBtn = box.querySelector('[data-step-dir="1"]');
    if (!input) return;

    const min = input.min !== "" ? parseFloat(input.min) : -Infinity;
    const max = input.max !== "" ? parseFloat(input.max) : Infinity;
    const val = parseFloat(input.value);

    if (Number.isNaN(val)) {
        if (prevBtn) prevBtn.disabled = false;
        if (nextBtn) nextBtn.disabled = false;
        return;
    }

    if (prevBtn) prevBtn.disabled = val <= min;
    if (nextBtn) nextBtn.disabled = val >= max;
}

document.querySelectorAll(".stepper-box").forEach(box => {
    const input = box.querySelector('input[type="number"]');
    if (!input) return;

    box.querySelectorAll(".stepper-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const dir = parseInt(btn.dataset.stepDir, 10) || 0;
            const step = parseFloat(input.step) || 1;
            const min = input.min !== "" ? parseFloat(input.min) : -Infinity;
            const max = input.max !== "" ? parseFloat(input.max) : Infinity;
            const decimals = getStepDecimals(step);

            const current = Number.isNaN(parseFloat(input.value))
                ? (min !== -Infinity ? min : 0)
                : parseFloat(input.value);

            let next = current + dir * step;
            next = Math.min(max, Math.max(min, next));
            next = Number(next.toFixed(decimals));

            input.value = String(next);
            input.dispatchEvent(new Event("change", { bubbles: true }));
            syncStepperButtons(box);
        });
    });

    input.addEventListener("input", () => syncStepperButtons(box));
    input.addEventListener("change", () => syncStepperButtons(box));
    syncStepperButtons(box);
});

function resolveEffectiveTheme(mode) {
    if (mode === "mesh" || mode === "light" || mode === "dark") {
        return mode;
    }
    return darkSchemeMedia.matches ? "dark" : "mesh";
}

function applyThemeMode(mode) {
    const validMode = ["mesh", "light", "dark", "auto"].includes(mode)
        ? (mode === "auto" ? "mesh" : mode)
        : "mesh";
    currentThemeMode = validMode;

    const radio = document.querySelector(`input[name="themeMode"][value="${validMode}"]`);
    if (radio) radio.checked = true;

    document.documentElement.setAttribute("data-theme", resolveEffectiveTheme(validMode));
}

darkSchemeMedia.addEventListener("change", () => {
    if (currentThemeMode === "auto") {
        applyThemeMode("auto");
    }
});

document.querySelectorAll('input[name="themeMode"]').forEach(input => {
    input.addEventListener("change", () => {
        applyThemeMode(input.value);
    });
});

function formatFontStepLabel(step) {
    const n = Math.max(-2, Math.min(2, Number(step) || 0));
    if (n === 0) return "0 (стандарт)";
    return n > 0 ? `+${n}` : `${n}`;
}

function applyFontScaleStep(step) {
    const n = Math.max(-2, Math.min(2, Number(step) || 0));
    document.documentElement.style.setProperty("--font-offset", `${n}px`);
    if (fontScaleSlider) fontScaleSlider.value = String(n);
    if (fontScaleBadge) fontScaleBadge.textContent = formatFontStepLabel(n);
}

fontScaleSlider?.addEventListener("input", () => {
    applyFontScaleStep(fontScaleSlider.value);
});

let currentWindowId = null;
const currentWindowIdPromise = chrome.windows.getCurrent().then(win => {
    currentWindowId = win.id;
    return win.id;
});

async function sendMessageToBackground(payload) {
    const windowId = currentWindowId ?? await currentWindowIdPromise;
    return chrome.runtime.sendMessage({
        ...payload,
        windowId
    });
}

window.MeshMetricsUI?.initMetricsUI({
    onRefreshRequest: (force = false) => {
        sendMessageToBackground({
            target: "content",
            payload: { action: "sync_teacher_metrics", force: Boolean(force) }
        });
    }
});

// Создаём карточку-аккордеон для ассистента «Учебные умения»
const skillsCard = typeof createAssistantCard === "function"
    ? createAssistantCard({
        id: "skills",
        title: "Учебные умения",
        open: true,
        onTogglePause: (nextPaused) => {
            isTaskPaused = Boolean(nextPaused);
            const action = isTaskPaused ? "pause" : "resume";
            skillsCard.setPausedState(
                isTaskPaused,
                isTaskPaused ? "На паузе" : "Возобновление..."
            );
            sendMessageToBackground({
                target: "content",
                payload: { action }
            });
        },
        onStop: () => {
            isTaskPaused = false;
            sendMessageToBackground({
                target: "content",
                payload: { action: "stop" }
            });
        },
        onReload: () => {
            isTaskPaused = false;
            isTaskRunning = false;
            skillsCard.hideRunPanel();
            sendMessageToBackground({ action: "reload_active_tab" });
        },
        onOpenReport: openReportPage
    })
    : null;

if (assistantsAccordion && skillsCard) {
    assistantsAccordion.appendChild(skillsCard.element);
    if (skillsControls) {
        skillsCard.refs.settingsSlot.appendChild(skillsControls);
    }
}

async function getActiveTabUrl() {
    try {
        const windowId = currentWindowId ?? await currentWindowIdPromise;
        const [tab] = await chrome.tabs.query({ active: true, windowId });
        return tab?.url || "";
    } catch {
        return "";
    }
}

async function applyPageAssistantsState({ isClassJournal, tabUrl = "" }) {
    const normalizedJournal = Boolean(isClassJournal);
    lastAppliedClassJournal = normalizedJournal;

    const resolvedUrl = tabUrl || await getActiveTabUrl();
    const isMesh = normalizedJournal || (window.MeshMetricsUI?.isMeshUrl?.(resolvedUrl) ?? false);
    const assistantsCount = isMesh ? (normalizedJournal ? 2 : 1) : 0;

    if (normalizedJournal) {
        if (notClassJournalHint) notClassJournalHint.style.display = "none";
        if (assistantsAccordion) assistantsAccordion.style.display = "block";
        // Если активны оба ассистента — сворачиваем «Учебные умения», пока задача не запущена
        if (!isTaskRunning) {
            skillsCard?.setCollapsed(true);
        }
    } else {
        if (assistantsAccordion) assistantsAccordion.style.display = "none";
        if (!isTaskRunning) {
            skillsCard?.hideRunPanel();
        }
        // На страницах МЭШ работает ассистент показателей, поэтому общую заглушку «откройте МЭШ» скрываем
        if (notClassJournalHint) {
            notClassJournalHint.style.display = isMesh ? "none" : "block";
        }
    }

    window.MeshMetricsUI?.setPageContext?.({
        url: resolvedUrl,
        isMesh,
        assistantsCount,
        forceSync: false
    });
}

function requestPageContextWithRetry(retriesLeft = 3, knownUrl = "") {
    clearTimeout(contextRetryTimer);

    sendMessageToBackground({
        target: "content",
        payload: { action: "check_context" }
    }).then((res) => {
        if (res && typeof res.isClassJournal === "boolean") {
            applyPageAssistantsState({
                isClassJournal: res.isClassJournal,
                tabUrl: res.url || knownUrl
            });
            return;
        }
        if (retriesLeft > 0) {
            contextRetryTimer = setTimeout(() => {
                requestPageContextWithRetry(retriesLeft - 1, knownUrl);
            }, 700);
        } else {
            applyPageAssistantsState({ isClassJournal: false, tabUrl: knownUrl });
        }
    }).catch(() => {
        if (retriesLeft > 0) {
            contextRetryTimer = setTimeout(() => {
                requestPageContextWithRetry(retriesLeft - 1, knownUrl);
            }, 700);
        } else {
            applyPageAssistantsState({ isClassJournal: false, tabUrl: knownUrl });
        }
    });
}

document.querySelectorAll(".link-btn[data-url]").forEach(btn => {
    btn.addEventListener("click", () => {
        sendMessageToBackground({
            action: "open_url",
            url: btn.dataset.url
        });
    });
});

document.getElementById("openLastReportBtn")?.addEventListener("click", openReportPage);

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.reportHistory) {
        refreshLastReportLink();
    }
    if (changes.schoolMarkRules) {
        refreshSchoolRulesUI(changes.schoolMarkRules.newValue);
    }
});

document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));

        btn.classList.add("active");
        const targetPane = document.getElementById(`tab-${btn.dataset.tab}`);
        if (targetPane) targetPane.classList.add("active");
    });
});

async function loadSettingsUI() {
    const data = await chrome.storage.local.get({ settings: DEFAULT_SETTINGS });
    const s = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };

    applyThemeMode(s.themeMode ?? "mesh");
    applyFontScaleStep(s.fontScaleStep ?? 0);
    document.getElementById("highThreshold").value = s.highThreshold;
    document.getElementById("midThreshold").value = s.midThreshold;
    document.getElementById("lowThreshold").value = s.lowThreshold;
    document.getElementById("absenceThreshold").value = Math.round((s.absenceRatio ?? 0.5) * 100);

    document.querySelectorAll(".stepper-box").forEach(syncStepperButtons);
}

loadSettingsUI();
refreshSchoolRulesUI();
refreshLastReportLink();
requestPageContextWithRetry();

document.getElementById("saveSettingsBtn")?.addEventListener("click", async () => {
    const themeMode = document.querySelector('input[name="themeMode"]:checked')?.value || "mesh";
    const fontScaleStep = Math.max(-2, Math.min(2, parseInt(fontScaleSlider.value, 10) || 0));
    const highThreshold = parseFloat(document.getElementById("highThreshold").value) || 4.5;
    const midThreshold = parseFloat(document.getElementById("midThreshold").value) || 3.5;
    const lowThreshold = parseFloat(document.getElementById("lowThreshold").value) || 2.5;
    const absencePct = Math.min(95, Math.max(10, parseFloat(document.getElementById("absenceThreshold").value) || 50));

    const settings = {
        themeMode,
        fontScaleStep,
        highThreshold,
        midThreshold,
        lowThreshold,
        absenceRatio: absencePct / 100
    };

    await chrome.storage.local.set({ settings });

    const statusEl = document.getElementById("saveStatus");
    if (statusEl) {
        statusEl.textContent = "Настройки сохранены";
        setTimeout(() => { statusEl.textContent = ""; }, 2000);
    }
});

document.getElementById("resetSettingsBtn")?.addEventListener("click", async () => {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    await loadSettingsUI();
    setAccordionOpen(themeAccordionBtn, themeAccordionBody, false);
    setAccordionOpen(fontAccordionBtn, fontAccordionBody, false);
    setAccordionOpen(thresholdsAccordionBtn, thresholdsAccordionBody, false);
    setAccordionOpen(schoolRulesAccordionBtn, schoolRulesAccordionBody, false);

    const statusEl = document.getElementById("saveStatus");
    if (statusEl) {
        statusEl.textContent = "Сброшено по умолчанию";
        setTimeout(() => { statusEl.textContent = ""; }, 2000);
    }
});

const startBtn = document.getElementById("startBtn");

// Реестр активных ассистентов для маршрутизации сообщений
const activeAssistants = {
    skills: skillsCard
};

function setRunningState(assistantId, running) {
    isTaskRunning = running;
    if (!running) {
        isTaskPaused = false;
    }
    if (startBtn) {
        startBtn.style.display = running ? "none" : "";
        startBtn.disabled = running;
    }
    activeAssistants[assistantId]?.setRunning(running);
}

startBtn?.addEventListener("click", () => {
    const mode = document.querySelector('input[name="mode"]:checked')?.value || "background";
    const forceRecalc = document.getElementById("forceRecalc").checked;
    const processAll = document.getElementById("processAll").checked;
    const assistantId = "skills";

    isTaskPaused = false;
    const card = activeAssistants[assistantId];

    if (card) {
        card.setCollapsed(false);
        card.showRunPanel("neutral");
        card.refs.status.textContent = "Обработка...";
        card.refs.className.textContent = "Подготовка...";
        card.refs.studentName.textContent = "Запуск...";
        card.refs.counter.textContent = "0 из 0";
        card.refs.barFill.style.width = "0%";
        card.refs.summary.classList.remove("visible");
        card.refs.summary.textContent = "";
        card.refs.actions.classList.remove("visible");
        if (card.refs.reportBtn) card.refs.reportBtn.hidden = true;
    }

    setRunningState(assistantId, true);

    sendMessageToBackground({
        target: "content",
        payload: {
            action: "start",
            assistantId,
            mode,
            forceRecalc,
            processAll
        }
    });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.target !== "sidepanel") return;

    const incomingWindowId = msg.windowId ?? sender?.tab?.windowId;
    if (incomingWindowId !== undefined && currentWindowId !== null && incomingWindowId !== currentWindowId) {
        return;
    }

    // 1. Обработка контекста страницы
    if (msg.type === "page_context") {
        clearTimeout(contextRetryTimer);
        const tabUrl = msg.url || sender?.tab?.url || "";
        if (msg.isClassJournal) {
            applyPageAssistantsState({ isClassJournal: true, tabUrl });
        } else if (msg.isJournalPage) {
            contextRetryTimer = setTimeout(() => {
                requestPageContextWithRetry(1, tabUrl);
            }, 800);
            if (lastAppliedClassJournal === null) {
                applyPageAssistantsState({ isClassJournal: false, tabUrl });
            }
        } else {
            applyPageAssistantsState({ isClassJournal: false, tabUrl });
        }
        return;
    }

    if (msg.type === "context_changed") {
        clearTimeout(contextRetryTimer);
        const tabUrl = msg.url || sender?.tab?.url || "";
        if (!msg.isJournal) {
            applyPageAssistantsState({ isClassJournal: false, tabUrl });
        } else {
            requestPageContextWithRetry(3, tabUrl);
        }
        return;
    }

    // 2. Обработка состояний робота (пауза, прогресс, финиш)
    const assistantId = msg.assistantId || "skills";
    const card = activeAssistants[assistantId];

    if (msg.type === "paused") {
        isTaskPaused = Boolean(msg.isPaused);
        card?.setPausedState(
            isTaskPaused,
            isTaskPaused ? "На паузе" : "Обработка..."
        );
        return;
    }

    if (msg.type === "progress") {
        if (!card) return;
        card.showRunPanel("neutral");
        if (!isTaskPaused) {
            card.setRunning(true);
            card.refs.status.textContent = "Обработка...";
        }
        if (msg.className !== undefined) card.refs.className.textContent = msg.className;
        if (msg.studentName !== undefined) card.refs.studentName.textContent = msg.studentName;
        if (msg.current !== undefined && msg.total !== undefined) {
            card.refs.counter.textContent = `${msg.current} из ${msg.total}`;
            const pct = msg.total > 0 ? Math.min(100, Math.round((msg.current / msg.total) * 100)) : 0;
            card.refs.barFill.style.width = `${pct}%`;
        }
    } else if (msg.type === "finish" || msg.type === "error") {
        setRunningState(assistantId, false);
        if (!card) return;

        card.setCollapsed(false);
        const isStopped = Boolean(msg.isStopped);
        const isErr = !isStopped && Boolean(msg.isError || msg.type === "error");

        card.showRunPanel(isErr ? "error" : (isStopped ? "neutral" : "success"));

        if (isStopped) {
            card.refs.badge.className = "assistant-card-badge is-paused";
            card.refs.badge.textContent = "Остановлено";
        } else if (isErr) {
            card.refs.badge.className = "assistant-card-badge is-error";
            card.refs.badge.textContent = "Ошибка";
        } else {
            card.refs.badge.className = "assistant-card-badge is-success";
            card.refs.badge.textContent = "Готово";
        }

        card.refs.status.textContent = msg.title || (
            isStopped ? "Остановлено" : (isErr ? "Ошибка" : "Готово!")
        );
        if (!isErr && !isStopped) card.refs.barFill.style.width = "100%";

        card.refs.summary.textContent = msg.summary || "";
        card.refs.summary.classList.add("visible");
        card.refs.actions.classList.add("visible");
        if (card.refs.reportBtn) card.refs.reportBtn.hidden = isErr;
    }
});

const guideDialog = document.getElementById("guideDialog");
const closeGuideBtn = document.getElementById("closeGuideBtn");
const guideVersionBadge = document.getElementById("guideVersionBadge");
if (guideVersionBadge && chrome?.runtime?.getManifest) {
    guideVersionBadge.textContent = `v${chrome.runtime.getManifest().version}`;
}

document.querySelectorAll("[data-open-guide]").forEach(btn => {
    btn.addEventListener("click", () => {
        if (guideDialog && !guideDialog.open) {
            guideDialog.showModal();
        }
    });
});

closeGuideBtn?.addEventListener("click", () => {
    guideDialog?.close();
});

guideDialog?.addEventListener("click", (e) => {
    if (e.target === guideDialog) {
        guideDialog.close();
    }
});