(() => {
    if (window.MeshJournalStatic) return;

    const STORAGE_KEY = "schoolMarkRules";
    const CACHE_TTL_MS = 15 * 60 * 1000;

    // Технический резерв исключительно для расчётов в роботах (не показывается в UI как реальные данные)
    const DEFAULT_SCHOOL_MARK_RULES = {
        mark2: 2.0,
        mark3: 2.5,
        mark4: 3.5,
        mark5: 4.5,
        creditThreshold: 3.0,
        includeInterim: false,
        academicYearId: 14,
        organizationId: 573,
        updatedAt: null
    };

    function parseThreshold(val) {
        if (val === undefined || val === null || val === "") return null;
        const num = Number(String(val).replace(",", "."));
        return Number.isFinite(num) ? num : null;
    }

    function resolveJournalContextParams() {
        let academicYearId = null;
        let organizationId = null;

        try {
            const resources = performance.getEntriesByType("resource") || [];
            for (let i = resources.length - 1; i >= 0; i--) {
                const urlStr = resources[i].name || "";
                if (!urlStr.includes("school.mos.ru")) continue;

                const u = new URL(urlStr);
                if (!academicYearId) {
                    const ay = u.searchParams.get("academic_year_id") || u.searchParams.get("id");
                    if (ay && /^\d+$/.test(ay)) academicYearId = Number(ay);
                }
                if (!organizationId) {
                    const org = u.searchParams.get("organization_id") || u.searchParams.get("school_id");
                    if (org && /^\d+$/.test(org)) organizationId = Number(org);
                }
                if (academicYearId && organizationId) break;
            }
        } catch {}

        try {
            const pageUrl = new URL(window.location.href);
            if (!academicYearId) {
                const ay = pageUrl.searchParams.get("academic_year_id");
                if (ay && /^\d+$/.test(ay)) academicYearId = Number(ay);
            }
            if (!organizationId) {
                const org = pageUrl.searchParams.get("organization_id") || pageUrl.searchParams.get("school_id");
                if (org && /^\d+$/.test(org)) organizationId = Number(org);
            }
        } catch {}

        return {
            academicYearId: academicYearId || DEFAULT_SCHOOL_MARK_RULES.academicYearId,
            organizationId: organizationId || DEFAULT_SCHOOL_MARK_RULES.organizationId
        };
    }

    function normalizeSchoolMarkRules(rawPayload, params = {}) {
        const src =
            rawPayload?.rounding_limits_for_final_marks_response ||
            rawPayload?.payload?.rounding_limits_for_final_marks_response ||
            rawPayload?.data?.rounding_limits_for_final_marks_response ||
            rawPayload ||
            {};

        return {
            mark2: parseThreshold(src.rounding_limits_for_estimates_for_2),
            mark3: parseThreshold(src.rounding_limits_for_estimates_for_3),
            mark4: parseThreshold(src.rounding_limits_for_estimates_for_4),
            mark5: parseThreshold(src.rounding_limits_for_estimates_for_5),
            creditThreshold: parseThreshold(src.rounding_limits_for_estimates_for_approve),
            includeInterim: typeof src.sign_of_the_use_mark_for_intermediate_attestation === "boolean"
                ? src.sign_of_the_use_mark_for_intermediate_attestation
                : Boolean(src.sign_of_the_use_mark_for_intermediate_attestation),
            academicYearId: params.academicYearId ?? DEFAULT_SCHOOL_MARK_RULES.academicYearId,
            organizationId: params.organizationId ?? DEFAULT_SCHOOL_MARK_RULES.organizationId,
            updatedAt: new Date().toISOString(),
            lastError: null
        };
    }

    async function getSchoolMarkRules() {
        try {
            if (!chrome?.storage?.local) return null;
            const data = await chrome.storage.local.get(STORAGE_KEY);
            return data?.[STORAGE_KEY] || null;
        } catch {
            return null;
        }
    }

    // Гарантирует числовые значения только там, где они нужны для расчётов в ассистентах
    async function getSchoolMarkRulesForCalc() {
        const stored = await getSchoolMarkRules();
        if (!stored) return { ...DEFAULT_SCHOOL_MARK_RULES };

        return {
            ...DEFAULT_SCHOOL_MARK_RULES,
            ...Object.fromEntries(
                Object.entries(stored).filter(([, v]) => v !== null && v !== undefined)
            )
        };
    }

    async function fetchSchoolMarkRulesByParams(params) {
        const url =
            `https://school.mos.ru/api/ej/core/teacher/v1/school_settings/get_setting` +
            `?academic_year_id=${encodeURIComponent(params.academicYearId)}` +
            `&organization_id=${encodeURIComponent(params.organizationId)}`;

        const response = await window.MeshCore.apiFetch(url);
        const normalized = normalizeSchoolMarkRules(response, params);
        if (chrome?.storage?.local) {
            await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
        }
        return normalized;
    }

    async function syncSchoolMarkRules(force = false) {
        const params = resolveJournalContextParams();
        const existing = await getSchoolMarkRules();

        try {
            if (!chrome?.storage?.local || !window.MeshCore?.apiFetch) {
                return existing;
            }

            if (!force && existing?.updatedAt && !existing?.lastError) {
                const ageMs = Date.now() - new Date(existing.updatedAt).getTime();
                const sameContext =
                    existing.academicYearId === params.academicYearId &&
                    existing.organizationId === params.organizationId;
                if (sameContext && ageMs < CACHE_TTL_MS) {
                    return existing;
                }
            }

            return await fetchSchoolMarkRulesByParams(params);
        } catch (err) {
            const msg = String(err?.message || "");
            if (msg.includes("403") && params.organizationId !== DEFAULT_SCHOOL_MARK_RULES.organizationId) {
                try {
                    return await fetchSchoolMarkRulesByParams({
                        ...params,
                        organizationId: DEFAULT_SCHOOL_MARK_RULES.organizationId
                    });
                } catch {}
            }

            console.warn("[МЭШ Ассистент] Не удалось синхронизировать правила школы:", err);

            const errorState = {
                ...(existing || {}),
                updatedAt: existing?.updatedAt || null,
                lastError: "Что-то пошло не так при загрузке правил школы. Обновите страницу журнала и попробуйте ещё раз."
            };

            if (chrome?.storage?.local) {
                await chrome.storage.local.set({ [STORAGE_KEY]: errorState }).catch(() => {});
            }
            return errorState;
        }
    }

    function formatThreshold(val) {
        if (val === null || val === undefined || val === "") return "—";
        const n = Number(val);
        return Number.isFinite(n) ? n.toFixed(2) : "—";
    }

    function renderSchoolMarkRulesToDom(rules, elements = {}) {
        const hasLoadedData = Boolean(rules && rules.updatedAt);

        const setText = (el, text) => {
            if (el) el.textContent = text;
        };

        if (!hasLoadedData) {
            setText(elements.mark5El, "—");
            setText(elements.mark4El, "—");
            setText(elements.mark3El, "—");
            setText(elements.mark2El, "—");
            setText(elements.creditEl, "—");
            setText(elements.interimEl, "—");

            if (elements.metaEl) {
                elements.metaEl.textContent =
                    rules?.lastError ||
                    "Данные ещё не загружены. Откройте или обновите страницу журнала МЭШ и попробуйте ещё раз.";
            }
            return;
        }

        setText(elements.mark5El, formatThreshold(rules.mark5));
        setText(elements.mark4El, formatThreshold(rules.mark4));
        setText(elements.mark3El, formatThreshold(rules.mark3));
        setText(elements.mark2El, formatThreshold(rules.mark2));
        setText(elements.creditEl, formatThreshold(rules.creditThreshold));
        setText(elements.interimEl, rules.includeInterim ? "Учитывается" : "Не учитывается");

        if (elements.metaEl) {
            const stamp = new Date(rules.updatedAt).toLocaleString("ru-RU", {
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
            });

            if (rules.lastError) {
                elements.metaEl.textContent = `Не удалось обновить данные — показаны сохранённые от ${stamp}. Обновите страницу журнала и попробуйте ещё раз.`;
            } else {
                elements.metaEl.textContent = `Информация для ознакомления, взята из настроек журнала на текущий учебный год (обновлено ${stamp}).`;
            }
        }
    }

    window.MeshJournalStatic = {
        STORAGE_KEY,
        DEFAULT_SCHOOL_MARK_RULES,
        resolveJournalContextParams,
        normalizeSchoolMarkRules,
        getSchoolMarkRules,
        getSchoolMarkRulesForCalc,
        syncSchoolMarkRules,
        formatThreshold,
        renderSchoolMarkRulesToDom
    };
})();