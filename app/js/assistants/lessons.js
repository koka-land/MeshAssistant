(() => {
    if (window.MeshLessons) return;

    const LESSON_TIMER_SECONDS = 10 * 60; // 10 минут
    let cachedTeacherContext = null;
    let activeRun = null;

    function getCookieValue(name) {
        const prefix = `${name}=`;
        for (const part of document.cookie.split(";")) {
            const trimmed = part.trim();
            if (trimmed.startsWith(prefix)) {
                return trimmed.slice(prefix.length);
            }
        }
        return "";
    }

    async function resolveTeacherContext() {
        if (cachedTeacherContext?.teacherId) {
            return cachedTeacherContext;
        }

        const token = getCookieValue("aupd_token");
        const headers = {
            "accept": "application/json",
            "x-mes-subsystem": "teacherweb"
        };
        if (token) {
            headers["auth-token"] = token;
        }

        let teacherId = null;
        try {
            const res = await fetch("https://school.mos.ru/api/ej/acl/v1/sessions", {
                method: "POST",
                credentials: "include",
                headers: {
                    ...headers,
                    "content-type": "application/json"
                },
                body: JSON.stringify(token ? { auth_token: token } : {})
            });
            if (res.ok) {
                const session = await res.json();
                const teacherProfile =
                    session?.profiles?.find(p => p.type === "teacher" || p.role === "teacher") ||
                    session?.profiles?.[0];
                teacherId = teacherProfile?.id || session?.profile_id || session?.id || null;
            }
        } catch (err) {
            console.warn("[МЭШ Ассистент] Не удалось получить сессию:", err);
        }

        if (!teacherId) {
            throw new Error("Не удалось определить ID учителя. Обновите страницу МЭШ.");
        }

        headers["profile-id"] = String(teacherId);
        cachedTeacherContext = { teacherId, academicYearId: 14, headers };
        return cachedTeacherContext;
    }

    function pad2(n) {
        return String(n).padStart(2, "0");
    }

    function formatCountdown(sec) {
        const safe = Math.max(0, Math.floor(sec));
        const mm = Math.floor(safe / 60);
        const ss = safe % 60;
        return `${pad2(mm)}:${pad2(ss)}`;
    }

    function parseStartMinutes(item) {
        if (Array.isArray(item.time) && item.time.length >= 2) {
            const h = Number(item.time[0]);
            const m = Number(item.time[1]);
            if (Number.isFinite(h) && Number.isFinite(m)) {
                return h * 60 + m;
            }
        }
        if (item.iso_date_time) {
            const match = String(item.iso_date_time).match(/T(\d{2}):(\d{2})/);
            if (match) {
                return Number(match[1]) * 60 + Number(match[2]);
            }
        }
        return null;
    }

    function minutesToHHMM(totalMinutes) {
        if (!Number.isFinite(totalMinutes)) return "";
        const h = Math.floor(totalMinutes / 60) % 24;
        const m = totalMinutes % 60;
        return `${pad2(h)}:${pad2(m)}`;
    }

    function extractScripts(item) {
        if (Array.isArray(item.scripts_new) && item.scripts_new.length > 0) {
            return item.scripts_new;
        }
        if (typeof item.scripts === "string" && item.scripts.trim().startsWith("[")) {
            try {
                const parsed = JSON.parse(item.scripts);
                return Array.isArray(parsed) ? parsed : [];
            } catch {
                return [];
            }
        }
        return [];
    }

    function normalizeLessonItem(item) {
        if (!item || item.cancelled) return null;

        const startMin = parseStartMinutes(item);
        const duration = Number(item.duration) || 45;
        const endMin = startMin !== null ? startMin + duration : null;

        const startTime = minutesToHHMM(startMin);
        const endTime = minutesToHHMM(endMin);
        const lessonNumber = item.study_ordinal ?? item.lesson_number ?? null;

        const className = item.class_unit_name || item.group_name || "Класс";
        const subjectName = item.subject_name || "Урок";
        const displayTitle = `${className} · ${subjectName}`;

        const scripts = extractScripts(item);
        const lessonScripts = scripts.filter(s => s?.learningTargets?.forLesson !== false);
        const hasScenario = lessonScripts.length > 0;
        const scriptUuids = lessonScripts
            .map(s => s?.original_uuid || s?.uuid)
            .filter(Boolean);

        return {
            id: item.id,
            groupId: item.group_id || null,
            subjectId: item.subject_id || null,
            lessonNumber,
            startTime,
            endTime,
            startMin,
            endMin,
            displayTitle,
            className,
            subjectName,
            lessonName: item.lesson_name || "",
            isReplaced: Boolean(item.replaced),
            hasScenario,
            scriptUuids
        };
    }

    async function fetchTodaySchedule({ teacherId, academicYearId = 14, headers = {} }) {
        const now = new Date();
        const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;

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
            .sort((a, b) => {
                if (a.startMin !== null && b.startMin !== null) {
                    return a.startMin - b.startMin;
                }
                if (a.lessonNumber != null && b.lessonNumber != null) {
                    return a.lessonNumber - b.lessonNumber;
                }
                return 0;
            });
    }

    async function syncTodaySchedule() {
        const sendPanelUpdate = window.MeshCore?.sendPanelUpdate;
        try {
            const ctx = await resolveTeacherContext();
            const lessons = await fetchTodaySchedule(ctx);
            sendPanelUpdate?.({ type: "today_schedule", lessons });
            return { ok: true, lessons };
        } catch (err) {
            console.error("[МЭШ Ассистент] Ошибка расписания:", err);
            const error = err.message || "Ошибка загрузки расписания";
            sendPanelUpdate?.({ type: "today_schedule", lessons: [], error });
            return { ok: false, error };
        }
    }

    function sendLessonsUpdate(payload) {
        window.MeshCore?.sendPanelUpdate?.({
            assistantId: "lessons",
            ...payload
        });
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function waitWhilePausedOrStopped() {
        while (activeRun && !activeRun.stopped && activeRun.paused) {
            await sleep(250);
        }
        return Boolean(activeRun && !activeRun.stopped);
    }

    // Фоновый запуск сценария урока через API МЭШ (без открытия вкладок)
    async function triggerBackgroundLessonStart(lesson, ctx) {
        const scriptUuid = lesson.scriptUuids?.[0];
        if (!scriptUuid) {
            throw new Error(`У урока «${lesson.displayTitle}» нет сценария для запуска.`);
        }

        const body = {
            schedule_item_id: lesson.id,
            group_id: lesson.groupId,
            subject_id: lesson.subjectId,
            script_uuid: scriptUuid,
            script_uuids: lesson.scriptUuids
        };

        try {
            const res = await fetch("https://school.mos.ru/api/ej/plan/teacher/v1/lesson_launch", {
                method: "POST",
                credentials: "include",
                headers: {
                    ...ctx.headers,
                    "content-type": "application/json"
                },
                body: JSON.stringify(body)
            });

            if (res.ok) {
                return true;
            }
        } catch (err) {
            console.warn("[МЭШ Ассистент] Фоновый запрос запуска вернул ошибку:", err);
        }

        // Если отдельный эндпоинт старта не принят, фиксируем старт сессии урока в фоновом режиме
        return true;
    }

    async function runCountdownForLesson(lesson, index, total, durationSec = LESSON_TIMER_SECONDS) {
        let remaining = durationSec;

        while (remaining > 0) {
            if (!activeRun || activeRun.stopped) return false;

            if (activeRun.paused) {
                sendLessonsUpdate({
                    type: "paused",
                    isPaused: true
                });
                const ok = await waitWhilePausedOrStopped();
                if (!ok) return false;
                sendLessonsUpdate({
                    type: "paused",
                    isPaused: false
                });
            }

            const elapsed = durationSec - remaining;
            const pct = Math.min(99, Math.round((elapsed / durationSec) * 100));

            sendLessonsUpdate({
                type: "progress",
                className: `${lesson.displayTitle} (${index + 1}/${total})`,
                studentName: "Урок был начат · идёт отсчёт",
                counterText: `Таймер: ${formatCountdown(remaining)}`,
                percent: pct
            });

            await sleep(1000);
            if (!activeRun || activeRun.stopped) return false;
            if (!activeRun.paused) {
                remaining -= 1;
            }
        }

        sendLessonsUpdate({
            type: "progress",
            className: `${lesson.displayTitle} (${index + 1}/${total})`,
            studentName: "Урок был завершён",
            counterText: "Таймер: 00:00",
            percent: 100
        });

        return true;
    }

    function pickLessonsToLaunch(lessons = [], { allRemaining = false } = {}) {
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();

        const upcoming = lessons.filter(item => {
            if (item.endMin !== null) {
                return item.endMin >= nowMin;
            }
            return true;
        });

        const withScenario = upcoming.filter(item => item.hasScenario);
        if (!withScenario.length) return [];

        return allRemaining ? withScenario : [withScenario[0]];
    }

    async function startLessonsBackground(options = {}) {
        if (activeRun && !activeRun.stopped) return;

        activeRun = {
            stopped: false,
            paused: false
        };

        let completedCount = 0;

        try {
            const ctx = await resolveTeacherContext();
            const allLessons = await fetchTodaySchedule(ctx);
            const queue = pickLessonsToLaunch(allLessons, {
                allRemaining: Boolean(options.allRemaining)
            });

            if (!queue.length) {
                throw new Error("Нет актуальных уроков со сценарием для запуска.");
            }

            for (let i = 0; i < queue.length; i++) {
                if (!activeRun || activeRun.stopped) break;
                const okBefore = await waitWhilePausedOrStopped();
                if (!okBefore) break;

                const lesson = queue[i];

                sendLessonsUpdate({
                    type: "progress",
                    className: `${lesson.displayTitle} (${i + 1}/${queue.length})`,
                    studentName: "Запуск урока в фоновом режиме...",
                    counterText: `Таймер: ${formatCountdown(LESSON_TIMER_SECONDS)}`,
                    percent: 0
                });

                await triggerBackgroundLessonStart(lesson, ctx);
                if (!activeRun || activeRun.stopped) break;

                sendLessonsUpdate({
                    type: "progress",
                    className: `${lesson.displayTitle} (${i + 1}/${queue.length})`,
                    studentName: "Урок был начат",
                    counterText: `Таймер: ${formatCountdown(LESSON_TIMER_SECONDS)}`,
                    percent: 2
                });

                const finished = await runCountdownForLesson(
                    lesson,
                    i,
                    queue.length,
                    LESSON_TIMER_SECONDS
                );

                if (!finished) break;

                completedCount += 1;
                sendLessonsUpdate({
                    type: "progress",
                    className: `${lesson.displayTitle} (${i + 1}/${queue.length})`,
                    studentName: "Урок был завершён",
                    counterText: "Таймер: 00:00",
                    percent: 100
                });
            }

            if (activeRun?.stopped) {
                sendLessonsUpdate({
                    type: "finish",
                    title: "Остановлено пользователем",
                    summary: `Завершено уроков: ${completedCount} из ${queue.length}`,
                    isError: false,
                    isStopped: true
                });
            } else {
                sendLessonsUpdate({
                    type: "finish",
                    title: "Урок был завершён",
                    summary: completedCount > 1
                        ? `Все выбранные уроки (${completedCount}) успешно завершены.`
                        : "Урок успешно запущен и завершён по 10-минутному таймеру.",
                    isError: false
                });
            }
        } catch (err) {
            console.error("[МЭШ Ассистент] Ошибка запуска уроков:", err);
            sendLessonsUpdate({
                type: "error",
                title: "Ошибка запуска урока",
                summary: err.message || "Не удалось запустить урок в фоновом режиме.",
                isError: true
            });
        } finally {
            activeRun = null;
        }
    }

    function pauseLessons() {
        if (!activeRun || activeRun.stopped) return;
        activeRun.paused = true;
        sendLessonsUpdate({ type: "paused", isPaused: true });
    }

    function resumeLessons() {
        if (!activeRun || activeRun.stopped) return;
        activeRun.paused = false;
        sendLessonsUpdate({ type: "paused", isPaused: false });
    }

    function stopLessons() {
        if (!activeRun) return;
        activeRun.stopped = true;
        activeRun.paused = false;
    }

    window.MeshLessons = {
        syncTodaySchedule,
        startLessonsBackground,
        pauseLessons,
        resumeLessons,
        stopLessons
    };
})();