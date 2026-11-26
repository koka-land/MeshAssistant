(() => {
    if (window.MeshTeacherMetrics) return;

    const STORAGE_KEY = "teacherMetrics";
    const CACHE_TTL_MS = 15 * 60 * 1000;

    function resolveProfileId() {
        try {
            const fromCookie = window.MeshCore?.getCookie?.("profile_id");
            if (fromCookie && /^\d+$/.test(String(fromCookie).trim())) {
                return String(fromCookie).trim();
            }
        } catch {}
        return null;
    }

    function parseDateBound(dateStr, isEnd = false) {
        if (!dateStr) return null;
        const d = new Date(dateStr);
        if (Number.isNaN(d.getTime())) return null;
        if (isEnd) {
            d.setHours(23, 59, 59, 999);
        } else {
            d.setHours(0, 0, 0, 0);
        }
        return d.getTime();
    }

    function isCurrentDateInPeriod(period, nowMs = Date.now()) {
        const startMs = parseDateBound(period?.startAt, false);
        const endMs = parseDateBound(period?.endAt, true);
        if (startMs === null || endMs === null) return false;
        return nowMs >= startMs && nowMs <= endMs;
    }

    function pickDefaultPeriodIndex(periods, nowMs = Date.now()) {
        if (!Array.isArray(periods) || periods.length === 0) return 0;

        const activeIdx = periods.findIndex(p => isCurrentDateInPeriod(p, nowMs));
        if (activeIdx !== -1) return activeIdx;

        let bestIdx = 0;
        let bestEnd = -Infinity;
        periods.forEach((p, idx) => {
            const endMs = parseDateBound(p.endAt, true);
            if (endMs !== null && endMs >= bestEnd) {
                bestEnd = endMs;
                bestIdx = idx;
            }
        });
        return bestIdx;
    }

    function normalizeMetricEntry(entry) {
        if (!entry || typeof entry !== "object") return null;
        return {
            name: entry.name || "",
            shortName: entry.shortName || "",
            value: entry.value ?? null,
            targetValue: entry.targetValue ?? null,
            targetValueForView: entry.targetValueForView ?? null,
            targetProgress: entry.targetProgress ?? null,
            success: Boolean(entry.success),
            color: entry.color || null,
            score: entry.score ?? null,
            isMain: Boolean(entry.isMain),
            note: entry.note || ""
        };
    }

    function normalizeItem(item) {
        if (!item || typeof item !== "object") return null;
        const base = normalizeMetricEntry(item);
        const subitems = Array.isArray(item.subitems)
            ? item.subitems.map(normalizeMetricEntry).filter(Boolean)
            : [];

        return {
            ...base,
            subitems
        };
    }

    function normalizePeriod(period) {
        if (!period || typeof period !== "object") return null;
        return {
            success: Boolean(period.success),
            startAt: period.startAt || null,
            endAt: period.endAt || null,
            updateAt: period.updateAt || null,
            isMainSuccess: Boolean(period.isMainSuccess),
            totalScore: period.totalScore ?? null,
            possibleScore: period.possibleScore ?? null,
            items: Array.isArray(period.items)
                ? period.items.map(normalizeItem).filter(Boolean)
                : []
        };
    }

    function normalizeTeacherMetrics(rawPayload, profileId) {
        const periods = Array.isArray(rawPayload?.periods)
            ? rawPayload.periods.map(normalizePeriod).filter(Boolean)
            : [];

        const selectedPeriodIndex = pickDefaultPeriodIndex(periods);
        const currentPeriod = periods[selectedPeriodIndex] || null;

        return {
            staffId: rawPayload?.staffId ?? null,
            profileId: String(rawPayload?.profileId || profileId || ""),
            recommendations: rawPayload?.recommendations || "",
            note: rawPayload?.note || "",
            periods,
            selectedPeriodIndex,
            currentPeriod,
            fetchedAt: new Date().toISOString(),
            lastError: null
        };
    }

    async function getTeacherMetrics() {
        try {
            if (!chrome?.storage?.local) return null;
            const data = await chrome.storage.local.get(STORAGE_KEY);
            return data?.[STORAGE_KEY] || null;
        } catch {
            return null;
        }
    }

    async function setSelectedPeriodIndex(index) {
        const current = await getTeacherMetrics();
        if (!current || !Array.isArray(current.periods) || !current.periods.length) {
            return null;
        }
        const safeIdx = Math.max(0, Math.min(current.periods.length - 1, Number(index) || 0));
        const updated = {
            ...current,
            selectedPeriodIndex: safeIdx,
            currentPeriod: current.periods[safeIdx] || null
        };
        if (chrome?.storage?.local) {
            await chrome.storage.local.set({ [STORAGE_KEY]: updated });
        }
        return updated;
    }

    async function saveErrorState(existing, message) {
        const errorState = {
            ...(existing || {}),
            fetchedAt: existing?.fetchedAt || null,
            lastError: message
        };
        if (chrome?.storage?.local) {
            await chrome.storage.local.set({ [STORAGE_KEY]: errorState }).catch(() => {});
        }
        return errorState;
    }

    async function syncTeacherMetrics(force = false) {
        const existing = await getTeacherMetrics();
        const profileId = resolveProfileId();

        if (!profileId) {
            return await saveErrorState(
                existing,
                "Что-то пошло не так — не удалось определить профиль. Обновите страницу МЭШ и попробуйте ещё раз."
            );
        }

        try {
            if (!window.MeshCore?.apiFetch) {
                return existing;
            }

            if (
                !force &&
                existing?.fetchedAt &&
                !existing?.lastError &&
                existing?.profileId === profileId
            ) {
                const ageMs = Date.now() - new Date(existing.fetchedAt).getTime();
                if (ageMs < CACHE_TTL_MS) {
                    return existing;
                }
            }

            const url = `https://school.mos.ru/api/teacher/assistant/v1/allowances?profileId=${encodeURIComponent(profileId)}`;
            const raw = await window.MeshCore.apiFetch(url);
            const normalized = normalizeTeacherMetrics(raw, profileId);

            if (chrome?.storage?.local) {
                await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
            }

            return normalized;
        } catch (err) {
            console.warn("[МЭШ Ассистент] Не удалось получить статистику показателей:", err);
            return await saveErrorState(
                existing,
                "Что-то пошло не так при загрузке показателей. Обновите страницу МЭШ и попробуйте ещё раз."
            );
        }
    }

    window.MeshTeacherMetrics = {
        STORAGE_KEY,
        resolveProfileId,
        isCurrentDateInPeriod,
        normalizeTeacherMetrics,
        getTeacherMetrics,
        setSelectedPeriodIndex,
        syncTeacherMetrics
    };
})();