(() => {
    if (window.MeshLessonsUI) return;

    let card = null;
    let dateLabelEl = null;
    let listEl = null;
    let refreshBtnEl = null;
    let startBtnEl = null;
    let allDayCheckboxEl = null;
    let autoAttachCheckboxEl = null;
    let requestScheduleFn = null;
    let sendCommandFn = null;
    let loaded = false;
    let loading = false;
    let isRunning = false;
    let isPaused = false;

    function escapeHtml(str) {
        return String(str ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function timeToMinutes(hhmm) {
        const [h, m] = String(hhmm || "").split(":").map(Number);
        if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
        return h * 60 + m;
    }

    function setLoading(isLoading) {
        loading = Boolean(isLoading);
        refreshBtnEl?.classList.toggle("is-loading", loading);
    }

    function setRunningState(running) {
        isRunning = Boolean(running);
        if (!isRunning) {
            isPaused = false;
        }
        if (startBtnEl) {
            startBtnEl.style.display = isRunning ? "none" : "";
            startBtnEl.disabled = isRunning;
        }
        card?.setRunning(isRunning);
    }

    function createLessonRow(lesson, { isPast = false, isCurrent = false } = {}) {
        const row = document.createElement("div");
        row.className = `lesson-item${isPast ? " is-past" : ""}${isCurrent ? " is-current" : ""}`;

        const timeLabel = lesson.startTime && lesson.endTime
            ? `${lesson.startTime}–${lesson.endTime}`
            : (lesson.startTime || "");

        const numHtml = lesson.lessonNumber != null
            ? `<span class="lesson-num">${escapeHtml(lesson.lessonNumber)}</span>`
            : "";

        const metaText = timeLabel
            ? `<span class="lesson-time">${escapeHtml(timeLabel)}</span>`
            : "";

        const replacedHtml = lesson.isReplaced
            ? `<span class="lesson-badge-replaced">Замена</span>`
            : "";

        const metaBlock = (numHtml || metaText || replacedHtml)
            ? `<div class="lesson-meta">${numHtml}${metaText}${replacedHtml}</div>`
            : "";

        const tagClass = lesson.hasScenario ? "has-scenario" : "no-scenario";
        const tagText = lesson.hasScenario ? "Сценарий" : "Нет сценария";
        const title = escapeHtml(lesson.displayTitle || `${lesson.className} · ${lesson.subjectName}`);
        const tooltip = escapeHtml(lesson.lessonName ? `${lesson.displayTitle} — ${lesson.lessonName}` : lesson.displayTitle);

        row.innerHTML = `
            <div class="lesson-main">
                ${metaBlock}
                <span class="lesson-title" title="${tooltip}">${title}</span>
            </div>
            <span class="lesson-tag ${tagClass}">${tagText}</span>
        `;
        return row;
    }

    function renderLessons(lessons = [], errorText = "") {
        if (!listEl) return;

        if (dateLabelEl) {
            const todayStr = new Date().toLocaleDateString("ru-RU", {
                day: "2-digit",
                month: "2-digit"
            });
            dateLabelEl.textContent = `Уроки на сегодня (${todayStr})`;
        }

        if (errorText) {
            listEl.innerHTML = `<div class="lessons-empty">${escapeHtml(errorText)}</div>`;
            if (startBtnEl && !isRunning) startBtnEl.disabled = true;
            return;
        }

        if (!Array.isArray(lessons) || lessons.length === 0) {
            listEl.innerHTML = `<div class="lessons-empty">На сегодня уроков не найдено</div>`;
            if (startBtnEl && !isRunning) startBtnEl.disabled = true;
            return;
        }

        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();

        const upcoming = [];
        const past = [];

        lessons.forEach(lesson => {
            const startMin = timeToMinutes(lesson.startTime);
            const endMin = timeToMinutes(lesson.endTime);
            const isPast = endMin !== null && endMin < nowMin;
            const isCurrent = startMin !== null && endMin !== null && nowMin >= startMin && nowMin <= endMin;

            if (isPast) {
                past.push(lesson);
            } else {
                upcoming.push({ lesson, isCurrent });
            }
        });

        listEl.innerHTML = "";

        if (upcoming.length > 0) {
            if (past.length > 0) {
                const cap = document.createElement("div");
                cap.className = "lessons-group-caption";
                cap.textContent = "Актуальные";
                listEl.appendChild(cap);
            }
            upcoming.forEach(({ lesson, isCurrent }) => {
                listEl.appendChild(createLessonRow(lesson, { isCurrent }));
            });
        }

        if (past.length > 0) {
            const cap = document.createElement("div");
            cap.className = "lessons-group-caption is-past-caption";
            cap.textContent = "Прошедшие";
            listEl.appendChild(cap);

            past.forEach(lesson => {
                listEl.appendChild(createLessonRow(lesson, { isPast: true }));
            });
        }

        const hasLaunchable = upcoming.some(({ lesson }) => Boolean(lesson.hasScenario));
        if (startBtnEl && !isRunning) {
            startBtnEl.disabled = !hasLaunchable;
        }
    }

    async function requestTodaySchedule(force = false) {
        if (loading) return;
        if (!force && loaded) return;

        setLoading(true);
        if (listEl && !loaded) {
            listEl.innerHTML = `<div class="lessons-empty">Загрузка расписания…</div>`;
        }

        try {
            const res = await requestScheduleFn?.(Boolean(force));
            if (res?.ok && Array.isArray(res.lessons)) {
                loaded = true;
                setLoading(false);
                renderLessons(res.lessons);
            } else if (res?.error) {
                setLoading(false);
                renderLessons([], res.error);
            }
        } catch {
            setLoading(false);
            renderLessons([], "Нет связи со страницей МЭШ");
        }
    }

    function handleStartClick() {
        if (!card || !sendCommandFn || isRunning) return;

        isPaused = false;
        const allRemaining = Boolean(allDayCheckboxEl?.checked);
        const autoAttach = Boolean(autoAttachCheckboxEl?.checked);

        card.setCollapsed(false);
        card.showRunPanel("neutral");
        card.refs.status.textContent = "В фоновом режиме";
        card.refs.className.textContent = "Подготовка урока...";
        card.refs.studentName.textContent = "Запуск...";
        card.refs.counter.textContent = "Таймер: 10:00";
        card.refs.barFill.style.width = "0%";
        card.refs.summary.classList.remove("visible");
        card.refs.summary.textContent = "";
        card.refs.actions.classList.remove("visible");
        if (card.refs.reportBtn) card.refs.reportBtn.hidden = true;

        setRunningState(true);

        sendCommandFn({
            action: "start_lessons",
            allRemaining,
            autoAttach
        });
    }

    function init({ container, onFetchSchedule, onSendCommand }) {
        requestScheduleFn = onFetchSchedule;
        sendCommandFn = onSendCommand;

        const controls = document.getElementById("lessonsControls");
        dateLabelEl = document.getElementById("lessonsDateLabel");
        listEl = document.getElementById("lessonsList");
        refreshBtnEl = document.getElementById("lessonsRefreshBtn");
        startBtnEl = document.getElementById("startLessonsBtn");
        allDayCheckboxEl = document.getElementById("lessonsAllDay");
        autoAttachCheckboxEl = document.getElementById("lessonsAutoAttach");

        if (typeof createAssistantCard === "function" && container) {
            card = createAssistantCard({
                id: "lessons",
                title: "Запуск уроков",
                open: false,
                onTogglePause: (nextPaused) => {
                    isPaused = Boolean(nextPaused);
                    card.setPausedState(
                        isPaused,
                        isPaused ? "На паузе" : "В фоновом режиме"
                    );
                    sendCommandFn?.({
                        action: isPaused ? "pause_lessons" : "resume_lessons"
                    });
                },
                onStop: () => {
                    isPaused = false;
                    sendCommandFn?.({ action: "stop_lessons" });
                }
            });
            container.appendChild(card.element);
            if (controls) {
                card.refs.settingsSlot.appendChild(controls);
            }
        }

        refreshBtnEl?.addEventListener("click", () => {
            requestTodaySchedule(true);
        });

        startBtnEl?.addEventListener("click", handleStartClick);

        return card;
    }

    function setVisible(visible) {
        if (card) {
            card.element.style.display = visible ? "" : "none";
        }
        if (visible) {
            requestTodaySchedule(false);
        }
    }

    function handleMessage(msg) {
        if (!msg) return false;

        if (msg.type === "today_schedule") {
            loaded = !msg.error;
            setLoading(false);
            renderLessons(msg.lessons || [], msg.error || "");
            return true;
        }

        if (msg.assistantId !== "lessons") return false;
        if (!card) return true;

        if (msg.type === "paused") {
            isPaused = Boolean(msg.isPaused);
            card.setPausedState(
                isPaused,
                isPaused ? "На паузе" : "В фоновом режиме"
            );
            return true;
        }

        if (msg.type === "progress") {
            card.showRunPanel("neutral");
            if (!isPaused) {
                setRunningState(true);
                card.refs.status.textContent = "В фоновом режиме";
            }
            if (msg.className !== undefined) card.refs.className.textContent = msg.className;
            if (msg.studentName !== undefined) card.refs.studentName.textContent = msg.studentName;
            if (msg.counterText !== undefined) card.refs.counter.textContent = msg.counterText;
            if (msg.percent !== undefined) {
                card.refs.barFill.style.width = `${Math.max(0, Math.min(100, Number(msg.percent) || 0))}%`;
            }
            return true;
        }

        if (msg.type === "finish" || msg.type === "error") {
            setRunningState(false);
            card.setCollapsed(false);

            const isStopped = Boolean(msg.isStopped);
            const isErr = !isStopped && Boolean(msg.isError || msg.type === "error");

            card.showRunPanel(isErr ? "error" : (isStopped ? "neutral" : "success"));
            card.setResultBadge(isStopped ? "paused" : (isErr ? "error" : "success"));

            card.refs.status.textContent = msg.title || (
                isStopped ? "Остановлено" : (isErr ? "Ошибка" : "Урок был завершён")
            );
            if (!isErr && !isStopped) card.refs.barFill.style.width = "100%";

            card.refs.summary.textContent = msg.summary || "";
            card.refs.summary.classList.add("visible");
            card.refs.actions.classList.add("visible");
            if (card.refs.reportBtn) card.refs.reportBtn.hidden = true;
            return true;
        }

        return false;
    }

    window.MeshLessonsUI = {
        init,
        getCard: () => card,
        setVisible,
        requestTodaySchedule,
        handleMessage
    };
})();