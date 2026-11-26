(() => {
    if (window.MeshMetricsUI) return;

    let isInitialized = false;
    let isOnMesh = false;
    let isOpen = false;
    let userToggledAccordion = false;
    let activeAssistantsCount = 1;
    let refreshCallback = null;

    function isMeshUrl(url = "") {
        return typeof url === "string" && url.startsWith("https://school.mos.ru/");
    }

    function formatPeriodLabel(period) {
        if (!period?.startAt && !period?.endAt) return "Период";
        const fmt = (iso) => {
            if (!iso) return "";
            const d = new Date(iso);
            return Number.isNaN(d.getTime())
                ? iso
                : d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
        };
        const base = `${fmt(period.startAt)} — ${fmt(period.endAt)}`;
        const isActive = window.MeshTeacherMetrics?.isCurrentDateInPeriod?.(period);
        return isActive ? `${base} · текущий` : base;
    }

    function formatRubles(amount) {
        const num = Number(amount) || 0;
        return `${num.toLocaleString("ru-RU")} ₽`;
    }

    function renderRingSvg(arcPct, thresholdPct) {
        const size = 88;
        const center = size / 2;

        const outerR = 39;
        const outerCirc = 2 * Math.PI * outerR;
        const clampedOuter = Math.max(0, Math.min(100, Number(arcPct) || 0));
        const outerOffset = outerCirc - (clampedOuter / 100) * outerCirc;

        const innerR = 32;
        const innerCirc = 2 * Math.PI * innerR;
        const hasThreshold = typeof thresholdPct === "number" && !Number.isNaN(thresholdPct);
        const clampedInner = hasThreshold ? Math.max(0, Math.min(100, thresholdPct)) : 0;
        const innerOffset = innerCirc - (clampedInner / 100) * innerCirc;

        const innerArcSvg = hasThreshold
            ? `
                <circle class="metric-inner-track" cx="${center}" cy="${center}" r="${innerR}"></circle>
                <circle
                    class="metric-inner-fill"
                    cx="${center}"
                    cy="${center}"
                    r="${innerR}"
                    stroke-dasharray="${innerCirc.toFixed(2)}"
                    stroke-dashoffset="${innerOffset.toFixed(2)}"
                ></circle>
            `
            : "";

        return `
            <svg class="metric-ring-svg" viewBox="0 0 ${size} ${size}" aria-hidden="true">
                <circle class="metric-outer-track" cx="${center}" cy="${center}" r="${outerR}"></circle>
                <circle
                    class="metric-outer-fill"
                    cx="${center}"
                    cy="${center}"
                    r="${outerR}"
                    stroke-dasharray="${outerCirc.toFixed(2)}"
                    stroke-dashoffset="${outerOffset.toFixed(2)}"
                ></circle>
                ${innerArcSvg}
            </svg>
        `;
    }

    function renderChartCard(card) {
        return `
            <div class="metric-chart-card ${card.success ? "is-done" : ""}">
                <div class="metric-ring-box">
                    ${renderRingSvg(card.arcPct, card.dotPct)}
                    <div class="metric-ring-center">
                        <span class="metric-ring-title">${card.title}</span>
                        <span class="metric-actual-val">${card.actualText}</span>
                        ${card.thresholdText ? `<span class="metric-threshold-val">${card.thresholdText}</span>` : ""}
                    </div>
                </div>
            </div>
        `;
    }

    function renderBonusBlock(allowance) {
        if (!allowance) return "";
        return `
            <div class="metrics-bonus-box">
                <span class="metrics-bonus-label">Примерная надбавка</span>
                <span class="metrics-bonus-sum">${formatRubles(allowance.estimatedAmount)} / ${formatRubles(allowance.maxAmount)}</span>
            </div>
        `;
    }

    function applyAccordionState() {
        const sectionEl = document.getElementById("metricsDashboardSection");
        const triggerBtn = document.getElementById("metricsAccordionBtn");
        const bodyEl = document.getElementById("metricsAccordionBody");

        if (!sectionEl) return;
        sectionEl.style.display = isOnMesh ? "" : "none";

        if (!isOnMesh || !triggerBtn || !bodyEl) return;

        if (!userToggledAccordion) {
            isOpen = activeAssistantsCount <= 1;
        }

        triggerBtn.setAttribute("aria-expanded", String(isOpen));
        bodyEl.classList.toggle("is-open", isOpen);

        const chevron = triggerBtn.querySelector(".accordion-chevron");
        if (chevron) {
            chevron.textContent = isOpen ? "▴" : "▾";
        }
    }

    function setAccordionOpen(open, { byUser = false } = {}) {
        if (byUser) {
            userToggledAccordion = true;
        }
        isOpen = Boolean(open);
        applyAccordionState();
    }

    async function renderDashboard(overrideRawState = null) {
        applyAccordionState();
        if (!isOnMesh) return;

        const periodSelect = document.getElementById("metricsPeriodSelect");
        const mandatoryGrid = document.getElementById("metricsMandatoryGrid");
        const additionalGrid = document.getElementById("metricsAdditionalGrid");
        const bonusContainer = document.getElementById("metricsBonusBox");
        const stateBox = document.getElementById("metricsStateBox");

        if (!mandatoryGrid || !additionalGrid || !window.MeshMetricsAssistant) return;

        const model = await window.MeshMetricsAssistant.getDashboardModel(overrideRawState);

        if (!model.hasData) {
            if (periodSelect) {
                periodSelect.innerHTML = `<option value="">Период недоступен</option>`;
            }
            mandatoryGrid.innerHTML = "";
            additionalGrid.innerHTML = "";
            if (bonusContainer) bonusContainer.innerHTML = "";
            if (stateBox) {
                stateBox.textContent =
                    model.lastError ||
                    "Что-то пошло не так — данные показателей не загружены. Обновите страницу и попробуйте ещё раз.";
                stateBox.style.display = "block";
            }
            return;
        }

        if (periodSelect) {
            periodSelect.innerHTML = model.periods
                .map((p, idx) => (
                    `<option value="${idx}" ${idx === model.selectedPeriodIndex ? "selected" : ""}>${formatPeriodLabel(p)}</option>`
                ))
                .join("");
        }

        if (stateBox) {
            stateBox.textContent = model.lastError || "";
            stateBox.style.display = model.lastError ? "block" : "none";
        }

        mandatoryGrid.innerHTML = model.mandatoryCards.map(renderChartCard).join("");
        additionalGrid.innerHTML = model.additionalCards.map(renderChartCard).join("");
        if (bonusContainer) {
            bonusContainer.innerHTML = renderBonusBlock(model.allowance);
        }
    }

    function setPageContext({ url = "", isMesh = undefined, assistantsCount = undefined, forceSync = false } = {}) {
        const prevOnMesh = isOnMesh;
        const prevCount = activeAssistantsCount;

        isOnMesh = typeof isMesh === "boolean" ? isMesh : isMeshUrl(url);
        if (typeof assistantsCount === "number" && assistantsCount > 0) {
            activeAssistantsCount = assistantsCount;
        }

        if (!isOnMesh) {
            userToggledAccordion = false;
            isOpen = false;
            applyAccordionState();
            return;
        }

        if (!prevOnMesh || prevCount !== activeAssistantsCount) {
            userToggledAccordion = false;
        }

        applyAccordionState();
        renderDashboard();
        refreshCallback?.(Boolean(forceSync));
    }

    function initMetricsUI({ onRefreshRequest } = {}) {
        refreshCallback = onRefreshRequest || null;

        if (isInitialized) {
            renderDashboard();
            return;
        }
        isInitialized = true;

        const accordionBtn = document.getElementById("metricsAccordionBtn");
        const periodSelect = document.getElementById("metricsPeriodSelect");
        const refreshBtn = document.getElementById("metricsRefreshBtn");

        accordionBtn?.addEventListener("click", () => {
            setAccordionOpen(!isOpen, { byUser: true });
        });

        periodSelect?.addEventListener("change", async (e) => {
            await window.MeshTeacherMetrics?.setSelectedPeriodIndex?.(Number(e.target.value));
            renderDashboard();
        });

        refreshBtn?.addEventListener("click", async () => {
            refreshBtn.classList.add("is-loading");
            try {
                if (refreshCallback) {
                    await refreshCallback(true);
                } else if (window.MeshMetricsAssistant?.refreshMetrics) {
                    await window.MeshMetricsAssistant.refreshMetrics(true);
                }
            } finally {
                refreshBtn.classList.remove("is-loading");
            }
        });

        if (chrome?.storage?.onChanged) {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === "local" && changes.teacherMetrics) {
                    renderDashboard(changes.teacherMetrics.newValue);
                }
            });
        }

        applyAccordionState();
    }

    window.MeshMetricsUI = {
        isMeshUrl,
        setAccordionOpen,
        setPageContext,
        renderDashboard,
        initMetricsUI
    };
})();