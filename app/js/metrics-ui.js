(() => {
    if (window.MeshMetricsUI) return;

    let isInitialized = false;
    let isOnMesh = false;
    let isOpen = false;
    let userToggledAccordion = false;
    let activeAssistantsCount = 1;
    let refreshCallback = null;
    let pendingAnimateOnStorage = false;

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

    function setDropdownOpen(open) {
        const dropdown = document.getElementById("metricsPeriodDropdown");
        const btn = document.getElementById("metricsPeriodBtn");
        if (!dropdown || !btn) return;

        const nextState = Boolean(open);
        dropdown.classList.toggle("is-open", nextState);
        btn.setAttribute("aria-expanded", String(nextState));
    }

    function renderSemiGaugeSvg(actualPct, targetPct) {
        const r = 38;
        const xLeft = 6;
        const xRight = 82;
        const yBase = 46;
        const arcPath = `M ${xLeft} ${yBase} A ${r} ${r} 0 0 1 ${xRight} ${yBase}`;
        const arcLen = Math.PI * r;

        const clampedActual = Math.max(0, Math.min(100, Number(actualPct) || 0));
        const actualOffset = arcLen - (clampedActual / 100) * arcLen;

        const hasTarget = typeof targetPct === "number" && !Number.isNaN(targetPct);
        const clampedTarget = hasTarget ? Math.max(0, Math.min(100, targetPct)) : 0;
        const targetOffset = arcLen - (clampedTarget / 100) * arcLen;

        const targetArcSvg = hasTarget
            ? `
                <path
                    class="metric-semi-target"
                    d="${arcPath}"
                    style="--arc-len:${arcLen.toFixed(2)}"
                    stroke-dasharray="${arcLen.toFixed(2)}"
                    stroke-dashoffset="${targetOffset.toFixed(2)}"
                ></path>
            `
            : "";

        return `
            <svg class="metric-semi-svg" viewBox="0 0 88 52" aria-hidden="true">
                <path class="metric-semi-track" d="${arcPath}"></path>
                ${targetArcSvg}
                <path
                    class="metric-semi-actual"
                    d="${arcPath}"
                    style="--arc-len:${arcLen.toFixed(2)}"
                    stroke-dasharray="${arcLen.toFixed(2)}"
                    stroke-dashoffset="${actualOffset.toFixed(2)}"
                ></path>
            </svg>
        `;
    }

    function renderChartCard(card) {
        return `
            <div class="metric-chart-card ${card.success ? "is-done" : ""}">
                <div class="metric-semi-box">
                    ${renderSemiGaugeSvg(card.arcPct, card.dotPct)}
                    <div class="metric-semi-values">
                        <span class="metric-actual-val">${card.actualText}</span>
                        ${card.thresholdText ? `<span class="metric-threshold-val">${card.thresholdText}</span>` : ""}
                    </div>
                </div>
                <div class="metric-card-caption">${card.title}</div>
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

    function triggerRingsSequenceAnimation(grids) {
        const activeGrids = grids.filter(Boolean);
        if (!activeGrids.length) return;

        activeGrids.forEach(grid => grid.classList.add("is-animating"));
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                activeGrids.forEach(grid => grid.classList.remove("is-animating"));
            });
        });
    }

    function applyAccordionState() {
        const sectionEl = document.getElementById("metricsDashboardSection");
        const triggerBtn = document.getElementById("metricsAccordionBtn");
        const bodyEl = document.getElementById("metricsAccordionBody");

        if (!sectionEl) return false;
        sectionEl.style.display = isOnMesh ? "" : "none";

        if (!isOnMesh || !triggerBtn || !bodyEl) return false;

        const wasOpen = isOpen;
        if (!userToggledAccordion) {
            isOpen = activeAssistantsCount <= 1;
        }

        triggerBtn.setAttribute("aria-expanded", String(isOpen));
        bodyEl.classList.toggle("is-open", isOpen);

        const chevron = triggerBtn.querySelector(".accordion-chevron");
        if (chevron) {
            chevron.textContent = isOpen ? "▴" : "▾";
        }

        if (!isOpen) {
            setDropdownOpen(false);
        }

        return !wasOpen && isOpen;
    }

    function setAccordionOpen(open, { byUser = false } = {}) {
        if (byUser) {
            userToggledAccordion = true;
        }
        const becameOpen = !isOpen && Boolean(open);
        isOpen = Boolean(open);
        applyAccordionState();

        if (becameOpen) {
            triggerRingsSequenceAnimation([
                document.getElementById("metricsMandatoryGrid"),
                document.getElementById("metricsAdditionalGrid")
            ]);
        }
    }

    async function renderDashboard(overrideRawState = null, { animate = false } = {}) {
        const becameOpen = applyAccordionState();
        if (!isOnMesh) return;

        const periodLabel = document.getElementById("metricsPeriodLabel");
        const periodMenu = document.getElementById("metricsPeriodMenu");
        const mandatoryGrid = document.getElementById("metricsMandatoryGrid");
        const additionalGrid = document.getElementById("metricsAdditionalGrid");
        const bonusContainer = document.getElementById("metricsBonusBox");
        const stateBox = document.getElementById("metricsStateBox");

        if (!mandatoryGrid || !additionalGrid || !window.MeshMetricsAssistant) return;

        const model = await window.MeshMetricsAssistant.getDashboardModel(overrideRawState);

        if (!model.hasData) {
            if (periodLabel) periodLabel.textContent = "Период недоступен";
            if (periodMenu) periodMenu.innerHTML = "";
            setDropdownOpen(false);
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

        const activePeriod = model.periods[model.selectedPeriodIndex] || model.periods[0];
        if (periodLabel) {
            periodLabel.textContent = formatPeriodLabel(activePeriod);
        }
        if (periodMenu) {
            periodMenu.innerHTML = model.periods
                .map((p, idx) => `
                    <button
                        type="button"
                        class="custom-select-option ${idx === model.selectedPeriodIndex ? "is-selected" : ""}"
                        role="option"
                        aria-selected="${idx === model.selectedPeriodIndex}"
                        data-period-index="${idx}"
                    >${formatPeriodLabel(p)}</button>
                `)
                .join("");
        }

        if (stateBox) {
            stateBox.textContent = model.lastError || "";
            stateBox.style.display = model.lastError ? "block" : "none";
        }

        const shouldAnimate = Boolean(animate || becameOpen) && isOpen;
        if (shouldAnimate) {
            mandatoryGrid.classList.add("is-animating");
            additionalGrid.classList.add("is-animating");
        }

        mandatoryGrid.innerHTML = model.mandatoryCards.map(renderChartCard).join("");
        additionalGrid.innerHTML = model.additionalCards.map(renderChartCard).join("");
        if (bonusContainer) {
            bonusContainer.innerHTML = renderBonusBlock(model.allowance);
        }

        if (shouldAnimate) {
            triggerRingsSequenceAnimation([mandatoryGrid, additionalGrid]);
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

        const becameOpen = applyAccordionState();
        renderDashboard(null, { animate: becameOpen });
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
        const periodBtn = document.getElementById("metricsPeriodBtn");
        const periodMenu = document.getElementById("metricsPeriodMenu");
        const refreshBtn = document.getElementById("metricsRefreshBtn");

        accordionBtn?.addEventListener("click", () => {
            setAccordionOpen(!isOpen, { byUser: true });
        });

        periodBtn?.addEventListener("click", (e) => {
            e.stopPropagation();
            const isExpanded = periodBtn.getAttribute("aria-expanded") === "true";
            setDropdownOpen(!isExpanded);
        });

        periodMenu?.addEventListener("click", async (e) => {
            const option = e.target.closest(".custom-select-option");
            if (!option) return;
            setDropdownOpen(false);
            await window.MeshTeacherMetrics?.setSelectedPeriodIndex?.(Number(option.dataset.periodIndex));
            renderDashboard(null, { animate: true });
        });

        document.addEventListener("click", (e) => {
            if (!e.target.closest("#metricsPeriodDropdown")) {
                setDropdownOpen(false);
            }
        });

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                setDropdownOpen(false);
            }
        });

        refreshBtn?.addEventListener("click", async () => {
            setDropdownOpen(false);
            refreshBtn.classList.add("is-loading");
            pendingAnimateOnStorage = true;
            try {
                if (refreshCallback) {
                    await refreshCallback(true);
                } else if (window.MeshMetricsAssistant?.refreshMetrics) {
                    await window.MeshMetricsAssistant.refreshMetrics(true);
                }
            } finally {
                setTimeout(() => {
                    refreshBtn.classList.remove("is-loading");
                    pendingAnimateOnStorage = false;
                }, 600);
            }
        });

        if (chrome?.storage?.onChanged) {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === "local" && changes.teacherMetrics) {
                    const shouldAnimate = pendingAnimateOnStorage;
                    pendingAnimateOnStorage = false;
                    renderDashboard(changes.teacherMetrics.newValue, { animate: shouldAnimate });
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