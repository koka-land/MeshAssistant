(() => {
    if (window.MeshMetricsAssistant) return;

    const BONUS_P1 = 5000;
    const BONUS_P2 = 5000;
    const BONUS_P3_PER_UNIT = 1000;
    const BONUS_P3_MAX = 5000;
    const BONUS_MAX = BONUS_P1 + BONUS_P2 + BONUS_P3_MAX;
    const SCANS_TARGET = 5;

    function normalizeKey(str = "") {
        return String(str)
            .toLowerCase()
            .replace(/ё/g, "е")
            .replace(/[\s_-]+/g, "");
    }

    function findTopItem(items, keys) {
        if (!Array.isArray(items)) return null;
        const targetSet = new Set(keys.map(normalizeKey));
        return items.find(item => {
            const shortK = normalizeKey(item.shortName);
            const nameK = normalizeKey(item.name);
            return targetSet.has(shortK) || targetSet.has(nameK);
        }) || null;
    }

    function pickSubitem(parentItem, index, keys) {
        const subs = Array.isArray(parentItem?.subitems) ? parentItem.subitems : [];
        const targetSet = new Set(keys.map(normalizeKey));
        const byKey = subs.find(s => targetSet.has(normalizeKey(s.shortName)) || targetSet.has(normalizeKey(s.name)));
        return byKey || subs[index] || null;
    }

    function parseNumber(raw) {
        if (raw === null || raw === undefined || raw === "") return null;
        const cleaned = String(raw).replace("%", "").replace(",", ".").trim();
        const num = Number(cleaned);
        return Number.isNaN(num) ? null : num;
    }

    function formatActualDisplay(entry, isScans = false) {
        if (!entry || entry.value === null || entry.value === undefined || entry.value === "") {
            return isScans ? "0" : "—";
        }
        const rawStr = String(entry.value).trim();
        if (rawStr.endsWith("%")) return rawStr;
        const num = parseNumber(rawStr);
        return num !== null ? String(num) : rawStr;
    }

    function formatThresholdDisplay(entry, isScans = false) {
        if (isScans) return String(SCANS_TARGET);

        const targetRaw = entry?.targetValue ?? entry?.targetValueForView;
        if (targetRaw === null || targetRaw === undefined || targetRaw === "") {
            return "";
        }
        const rawStr = String(targetRaw).trim();
        if (rawStr.endsWith("%")) return rawStr;
        const num = parseNumber(rawStr);
        return num !== null ? String(num) : rawStr;
    }

    function computeArcPct(entry, isScans = false) {
        if (!entry) return 0;

        if (isScans) {
            const count = getScansCompletedCount(entry);
            return Math.max(0, Math.min(100, Math.round((count / SCANS_TARGET) * 100)));
        }

        const val = parseNumber(entry.value);
        const goal = parseNumber(entry.targetValue ?? entry.targetValueForView);

        if (val !== null && goal !== null && goal > 0) {
            return Math.max(0, Math.min(100, Math.round((val / goal) * 100)));
        }
        if (typeof entry.targetProgress === "number" && !Number.isNaN(entry.targetProgress)) {
            return Math.max(0, Math.min(100, Math.round(entry.targetProgress)));
        }
        if (val !== null) {
            return Math.max(0, Math.min(100, Math.round(val)));
        }
        return entry.success ? 100 : 0;
    }

    function computeThresholdDotPct(entry, isScans = false) {
        if (isScans) return 100;

        const targetRaw = entry?.targetValue ?? entry?.targetValueForView;
        const goal = parseNumber(targetRaw);
        if (goal === null) return null;
        if (String(targetRaw).trim().endsWith("%")) {
            return Math.max(0, Math.min(100, Math.round(goal)));
        }
        return goal <= 100 ? Math.max(0, Math.min(100, Math.round(goal))) : 100;
    }

    function getScansCompletedCount(p3Item) {
        if (!p3Item) return 0;
        if (Array.isArray(p3Item.subitems) && p3Item.subitems.length > 0) {
            const doneSubs = p3Item.subitems.filter(s => Boolean(s.success)).length;
            return Math.max(0, Math.min(SCANS_TARGET, doneSubs));
        }
        const val = parseNumber(p3Item.value);
        if (val !== null) {
            return Math.max(0, Math.min(SCANS_TARGET, Math.floor(val)));
        }
        return p3Item.success ? SCANS_TARGET : 0;
    }

    function buildCardModel({ id, title, group, source, isScans = false }) {
        const present = Boolean(source) || isScans;
        const success = isScans
            ? getScansCompletedCount(source) >= SCANS_TARGET || Boolean(source?.success)
            : (present ? Boolean(source?.success) : false);
        const arcPct = computeArcPct(source, isScans);
        const dotPct = computeThresholdDotPct(source, isScans);
        const actualText = formatActualDisplay(source, isScans);
        const thresholdText = formatThresholdDisplay(source, isScans);

        return {
            id,
            title,
            group,
            present,
            success,
            arcPct,
            dotPct,
            actualText,
            thresholdText
        };
    }

    function calculateEstimatedAllowance(mandatoryCards, p1Item, p2Item, p3Item) {
        const mandatoryComplete = mandatoryCards.every(card => card.present && card.success);

        const p1Done = Boolean(p1Item?.success);
        const p2Done = Boolean(p2Item?.success);
        const p3Count = getScansCompletedCount(p3Item);

        const p1Amount = p1Done ? BONUS_P1 : 0;
        const p2Amount = p2Done ? BONUS_P2 : 0;
        const p3Amount = Math.min(BONUS_P3_MAX, p3Count * BONUS_P3_PER_UNIT);
        const potentialAmount = p1Amount + p2Amount + p3Amount;
        const estimatedAmount = mandatoryComplete ? potentialAmount : 0;

        return {
            mandatoryComplete,
            estimatedAmount,
            maxAmount: BONUS_MAX
        };
    }

    function buildDashboardModel(metricsState) {
        if (!metricsState || !Array.isArray(metricsState.periods) || metricsState.periods.length === 0) {
            return {
                hasData: false,
                lastError: metricsState?.lastError || null,
                periods: [],
                selectedPeriodIndex: 0,
                mandatoryCards: [],
                additionalCards: [],
                allowance: null
            };
        }

        const selectedPeriodIndex = Math.max(
            0,
            Math.min(metricsState.periods.length - 1, Number(metricsState.selectedPeriodIndex) || 0)
        );
        const period = metricsState.periods[selectedPeriodIndex] || metricsState.periods[0];
        const items = Array.isArray(period.items) ? period.items : [];

        const pk1Item = findTopItem(items, ["pk1", "пк1"]);
        const pk2Item = findTopItem(items, ["pk2", "пк2"]);
        const p1Item = findTopItem(items, ["p1", "п1"]);
        const p2Item = findTopItem(items, ["p2", "п2"]);
        const p3Item = findTopItem(items, ["p3", "п3"]);

        const ktpSub = pickSubitem(pk1Item, 0, ["pk1_1", "pk1-1", "пк1_1", "пк1-1", "ктп"]);
        const matSub = pickSubitem(pk1Item, 1, ["pk1_2", "pk1-2", "пк1_2", "пк1-2", "материалы"]);

        const mandatoryCards = [
            buildCardModel({
                id: "ktp",
                title: "КТП",
                group: "mandatory",
                source: ktpSub
            }),
            buildCardModel({
                id: "materials",
                title: "Привязка материалов",
                group: "mandatory",
                source: matSub
            }),
            buildCardModel({
                id: "homework",
                title: "Домашние задания",
                group: "mandatory",
                source: pk2Item
            })
        ];

        const additionalCards = [
            buildCardModel({
                id: "scenarios",
                title: "Сценарии",
                group: "additional",
                source: p1Item
            }),
            buildCardModel({
                id: "cdz",
                title: "ЦДЗ",
                group: "additional",
                source: p2Item
            }),
            buildCardModel({
                id: "scans",
                title: "Сканы",
                group: "additional",
                source: p3Item,
                isScans: true
            })
        ];

        const allowance = calculateEstimatedAllowance(mandatoryCards, p1Item, p2Item, p3Item);

        return {
            hasData: true,
            lastError: metricsState.lastError || null,
            periods: metricsState.periods,
            selectedPeriodIndex,
            mandatoryCards,
            additionalCards,
            allowance
        };
    }

    async function getDashboardModel(overrideState = null) {
        const state = overrideState || await window.MeshTeacherMetrics?.getTeacherMetrics?.();
        return buildDashboardModel(state);
    }

    window.MeshMetricsAssistant = {
        buildDashboardModel,
        getDashboardModel
    };
})();