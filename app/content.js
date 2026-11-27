(() => {
    if (window.meshRobotControllerLoaded) return;
    window.meshRobotControllerLoaded = true;

    const {
        getSettings,
        saveReportToHistory,
        sendPanelUpdate,
        detectJournalContext,
        reportJournalContext,
        closeOpenModalsOnStop,
        switchToFirstClass,
        switchNextClass
    } = window.MeshCore;

    async function fetchTodaySchedule({ teacherId, academicYearId = 14, headers = {} }) {
        const today = new Date().toISOString().slice(0, 10);
        const url = new URL("https://school.mos.ru/api/ej/plan/teacher/v1/schedule_items");
        url.searchParams.set("academic_year_id", String(academicYearId));
        url.searchParams.set("teacher_id", String(teacherId));
        url.searchParams.set("from", today);
        url.searchParams.set("to", today);
        url.searchParams.set("with_group_class_subject_info", "true");
        url.searchParams.set("with_lesson_info", "true");
        url.searchParams.set("with_course_calendar_info", "true");
        url.searchParams.set("with_rooms_info", "true");
        url.searchParams.set("original", "true");
        url.searchParams.set("page", "1");
        url.searchParams.set("per_page", "100");

        const res = await fetch(url.toString(), {
            credentials: "include",
            headers: {
                "accept": "application/json",
                "x-mes-subsystem": "teacherweb",
                ...headers
            }
        });

        if (!res.ok) {
            throw new Error(`Ошибка расписания: HTTP ${res.status}`);
        }

        const data = await res.json();
        const items = Array.isArray(data) ? data : (data.items || data.data || []);

        return items
            .map(normalizeLessonItem)
            .filter(Boolean)
            .sort((a, b) => a.startTime.localeCompare(b.startTime));
    }

    function normalizeLessonItem(item) {
        if (!item) return null;
        const startTime = String(item.begin_time || item.start_time || "").slice(0, 5);
        const endTime = String(item.end_time || "").slice(0, 5);
        const className = item.group_name || item.class_unit_name || item.class_unit?.name || "Класс";
        const subjectName = item.subject_name || item.subject?.name || "Урок";

        // Проверяем, есть ли прикреплённые материалы (уточним точное поле после первого живого ответа)
        const materials = item.lesson?.materials || item.materials || [];
        const hasScenario = Array.isArray(materials) && materials.length > 0;

        return {
            id: item.id,
            startTime,
            endTime,
            className,
            subjectName,
            hasScenario,
            raw: item
        };
    }

    async function loadSchoolRules() {
        if (!window.MeshJournalStatic) return null;
        return (
            (await window.MeshJournalStatic.syncSchoolMarkRules(false)) ||
            (await window.MeshJournalStatic.getSchoolMarkRules()) ||
            null
        );
    }

    async function runRobot(assistantId, options = {}) {
        if (window.isMeshRobotRunning) return;

        const assistant = window.MeshAssistants?.[assistantId];
        if (!assistant) {
            console.error(`[МЭШ Ассистент] Неизвестный ассистент: ${assistantId}`);
            return;
        }

        const { forceRecalc, processAll, mode = "background" } = options;
        window.isMeshRobotRunning = true;
        window.meshRobotStopRequested = false;
        window.meshRobotPaused = false;

        const globalStats = { processed: 0, alreadySet: 0, skipped: 0, classes: 0 };
        const allReportItems = [];

        try {
            const settings = await getSettings();
            const schoolRules = await loadSchoolRules();

            if (processAll) {
                sendPanelUpdate({ type: "progress", studentName: "Переход к первому классу..." });
                const switchedToFirst = await switchToFirstClass();
                if (!switchedToFirst || window.meshRobotStopRequested) {
                    if (!window.meshRobotStopRequested) {
                        throw new Error("Не удалось открыть список классов.");
                    }
                    return;
                }
            }

            do {
                if (window.meshRobotStopRequested) break;

                const dropdownWrapper = document.querySelector('[data-test-component="leftControlHeadSelectGroup-selectSingleWrapper"]');
                const currentClass = dropdownWrapper ? dropdownWrapper.textContent.trim() : "Текущий класс";

                const stats = mode === "background"
                    ? await assistant.processAPI(forceRecalc, currentClass, settings, schoolRules)
                    : await assistant.processUI(forceRecalc, currentClass, settings, schoolRules);

                globalStats.processed += stats.processed;
                globalStats.alreadySet += stats.alreadySet;
                globalStats.skipped += stats.skipped;
                globalStats.classes++;

                if (Array.isArray(stats.items)) {
                    allReportItems.push(...stats.items);
                }

                if (stats.aborted || window.meshRobotStopRequested || !processAll) break;

                sendPanelUpdate({ type: "progress", studentName: "Переключаем класс..." });
                const hasNext = await switchNextClass(currentClass);
                if (!hasNext) break;
            } while (true);

            if (allReportItems.length > 0) {
                const disputedCount = allReportItems.filter(i => i.disputed).length;
                await saveReportToHistory({
                    id: Date.now().toString(),
                    createdAt: new Date().toISOString(),
                    assistant: assistant.title || assistantId,
                    mode,
                    stopped: Boolean(window.meshRobotStopRequested),
                    summary: {
                        classes: globalStats.classes,
                        success: globalStats.processed,
                        skipped: globalStats.alreadySet,
                        noData: globalStats.skipped,
                        errors: 0,
                        disputed: disputedCount
                    },
                    items: allReportItems
                });
            }

            const summaryText =
                `Классов пройдено: ${globalStats.classes}\n` +
                `Успешно обработано: ${globalStats.processed}\n` +
                `Пропущено (уже стоят): ${globalStats.alreadySet}\n` +
                `Нет данных: ${globalStats.skipped}`;

            if (window.meshRobotStopRequested) {
                sendPanelUpdate({
                    type: "finish",
                    assistantId,
                    title: "Остановлено пользователем",
                    summary: summaryText,
                    isError: false,
                    isStopped: true,
                    showReload: mode === "background" && globalStats.processed > 0
                });
            } else {
                sendPanelUpdate({
                    type: "finish",
                    assistantId,
                    title: "Готово!",
                    summary: summaryText,
                    isError: false,
                    showReload: mode === "background"
                });
            }
        } catch (err) {
            console.error("[МЭШ Ассистент] Ошибка:", err);
            sendPanelUpdate({
                type: "error",
                assistantId,
                title: "Произошла ошибка",
                summary: `${err.message}\n\nПодробности в консоли (F12).`,
                isError: true,
                showReload: false
            });
        } finally {
            window.isMeshRobotRunning = false;
            window.meshRobotStopRequested = false;
            window.meshRobotPaused = false;
        }
    }

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        const action = request?.action || request?.payload?.action;
        const data = request?.payload || request || {};

        if (action === "start") {
            runRobot(data.assistantId || "skills", {
                forceRecalc: data.forceRecalc,
                processAll: data.processAll,
                mode: data.mode
            });
        } else if (action === "pause") {
            if (window.isMeshRobotRunning) {
                window.meshRobotPaused = true;
                sendPanelUpdate({ type: "paused", isPaused: true });
            }
        } else if (action === "resume") {
            window.meshRobotPaused = false;
            sendPanelUpdate({ type: "paused", isPaused: false });
        } else if (action === "stop") {
            window.meshRobotStopRequested = true;
            window.meshRobotPaused = false;
            closeOpenModalsOnStop();
        } else if (action === "check_context") {
            const ctx = detectJournalContext();
            reportJournalContext(true);
            sendResponse?.(ctx);
            return true;
        } else if (action === "sync_teacher_metrics") {
            window.MeshTeacherMetrics?.syncTeacherMetrics?.(Boolean(data.force));
}
    });

    reportJournalContext(true);
    window.MeshTeacherMetrics?.syncTeacherMetrics?.(false);
})();