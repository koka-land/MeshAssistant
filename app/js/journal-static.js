(() => {
    if (window.MeshJournalStatic) return;

    const STORAGE_KEY = "schoolMarkRules";
    const CACHE_TTL_MS = 15 * 60 * 1000;

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

    function parseThreshold(val, fallback) {
        if (val === undefined || val === null || val === "") return fallback;
        const num = Number(String(val).replace(",", "."));
        return Number.isFinite(num) ? num : fallback;
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
            mark2: parseThreshold(src.rounding_limits_for_estimates_for_2, DEFAULT_SCHOOL_MARK_RULES.mark2),
            mark3: parseThreshold(src.rounding_limits_for_estimates_for_3, DEFAULT_SCHOOL_MARK_RULES.mark3),
            mark4: parseThreshold(src.rounding_limits_for_estimates_for_4, DEFAULT_SCHOOL_MARK_RULES.mark4),
            mark5: parseThreshold(src.rounding_limits_for_estimates_for_5, DEFAULT_SCHOOL_MARK_RULES.mark5),
            creditThreshold: parseThreshold(
                src.rounding_limits_for_estimates_for_approve,
                DEFAULT_SCHOOL_MARK_RULES.creditThreshold
            ),
            includeInterim: Boolean(src.sign_of_the_use_mark_for_intermediate_attestation),
            academicYearId: params.academicYearId ?? DEFAULT_SCHOOL_MARK_RULES.academicYearId,
            organizationId: params.organizationId ?? DEFAULT_SCHOOL_MARK_RULES.organizationId,
            updatedAt: new Date().toISOString()
        };
    }

    async function getSchoolMarkRules() {
        try {
            if (!chrome?.storage?.local) return { ...DEFAULT_SCHOOL_MARK_RULES };
            const data = await chrome.storage.local.get(STORAGE_KEY);
            return { ...DEFAULT_SCHOOL_MARK_RULES, ...(data?.[STORAGE_KEY] || {}) };
        } catch {
            return { ...DEFAULT_SCHOOL_MARK_RULES };
        }
    }

    async function syncSchoolMarkRules(force = false) {
        try {
            if (!chrome?.storage?.local || !window.MeshCore?.apiFetch) return null;

            const existing = await getSchoolMarkRules();
            const params = resolveJournalContextParams();

            if (!force && existing.updatedAt) {
                const ageMs = Date.now() - new Date(existing.updatedAt).getTime();
                const sameContext =
                    existing.academicYearId === params.academicYearId &&
                    existing.organizationId === params.organizationId;
                if (sameContext && ageMs < CACHE_TTL_MS) {
                    return existing;
                }
            }

            const url =
                `https://school.mos.ru/api/ej/core/teacher/v1/school_settings/get_setting` +
                `?academic_year_id=${encodeURIComponent(params.academicYearId)}` +
                `&organization_id=${encodeURIComponent(params.organizationId)}`;

            const response = await window.MeshCore.apiFetch(url);
            const normalized = normalizeSchoolMarkRules(response, params);
            await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
            return normalized;
        } catch (err) {
            console.warn("[МЭШ Ассистент] Не удалось синхронизировать правила школы:", err);
            return null;
        }
    }

    function formatThreshold(val) {
        const n = Number(val);
        return Number.isFinite(n) ? n.toFixed(2) : "—";
    }

    function renderSchoolMarkRulesToDom(rules, elements = {}) {
        const r = { ...DEFAULT_SCHOOL_MARK_RULES, ...(rules || {}) };

        const setText = (el, text) => {
            if (el) el.textContent = text;
        };

        setText(elements.mark5El, formatThreshold(r.mark5));
        setText(elements.mark4El, formatThreshold(r.mark4));
        setText(elements.mark3El, formatThreshold(r.mark3));
        setText(elements.mark2El, formatThreshold(r.mark2));
        setText(elements.creditEl, formatThreshold(r.creditThreshold));
        setText(elements.interimEl, r.includeInterim ? "Учитывается" : "Не учитывается");

        if (elements.metaEl) {
            const scope = `год ID ${r.academicYearId}, ОО ID ${r.organizationId}`;
            if (r.updatedAt) {
                const stamp = new Date(r.updatedAt).toLocaleString("ru-RU", {
                    day: "2-digit",
                    month: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit"
                });
                elements.metaEl.textContent = `Информация для ознакомления, взята из настроек журнала на текущий учебный год (обновлено ${stamp}).`;
            } else {
                elements.metaEl.textContent = "Информация для ознакомления, взята из настроек журнала на текущий учебный год.";
            }
        }
    }

    window.MeshJournalStatic = {
        STORAGE_KEY,
        DEFAULT_SCHOOL_MARK_RULES,
        resolveJournalContextParams,
        normalizeSchoolMarkRules,
        getSchoolMarkRules,
        syncSchoolMarkRules,
        formatThreshold,
        renderSchoolMarkRulesToDom
    };
})();