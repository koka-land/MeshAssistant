(() => {
    window.MeshAssistants = window.MeshAssistants || {};
    if (window.MeshAssistants.skills) return;

    const {
        delay,
        DEFAULT_SETTINGS,
        sendPanelUpdate,
        getCookie,
        apiFetch,
        getGroupIdFromUrl,
        getElementByExactText,
        closeStudentModal,
        waitIfPaused
    } = window.MeshCore;

    const SKILL_LABELS = {
        1: "Почти никогда",
        2: "Редко",
        3: "Часто",
        4: "Почти всегда",
        5: "Затрудняюсь ответить"
    };

    const IMPORTANT_KEYWORDS = [
        "к/р", "с/р", "контрольн", "самостоятельн",
        "тест", "проверочн", "практическ", "диктант", "сочинен"
    ];

    const STANDARD_QUESTIONS = [
        { question_group_name: "Самоорганизация", questions: [{ question_id: 1 }, { question_id: 2 }] },
        { question_group_name: "Самообразование", questions: [{ question_id: 3 }, { question_id: 4 }] },
        { question_group_name: "Саморегуляция", questions: [{ question_id: 5 }, { question_id: 6 }, { question_id: 7 }] },
        { question_group_name: "Коммуникация", questions: [{ question_id: 11 }, { question_id: 13 }, { question_id: 14 }] }
    ];

    function getFallbackAcademicYear() {
        const now = new Date();
        const year = now.getFullYear();
        const beginYear = now.getMonth() >= 7 ? year : year - 1;
        return {
            begin: `01.09.${beginYear}`,
            end: `31.08.${beginYear + 1}`
        };
    }

    function calculateAnswers(stats, settings = DEFAULT_SETTINGS, questionGroups = STANDARD_QUESTIONS) {
        const {
            average,
            gradesCount,
            hwRatio,
            absenceRatio,
            unexcusedRatio,
            isUnstable,
            importantAvg
        } = stats;

        const high = settings.highThreshold ?? 4.5;
        const mid = settings.midThreshold ?? 3.5;
        const low = settings.lowThreshold ?? 2.5;
        const absLimit = settings.absenceRatio ?? 0.5;

        const answers = [];
        const hasManyAbsences = absenceRatio > absLimit;
        const hasEvaluatableGrades = gradesCount > 0 && average > low;

        if (hasManyAbsences && !hasEvaluatableGrades) {
            questionGroups.forEach(group => {
                group.questions.forEach(q => {
                    answers.push({ question_id: String(q.question_id), answer_id: 5 });
                });
            });
            return answers;
        }

        questionGroups.forEach(group => {
            const groupName = (group.question_group_name || "").toLowerCase();

            group.questions.forEach(q => {
                if (hasManyAbsences && (groupName.includes("саморегуляц") || groupName.includes("коммуникац"))) {
                    answers.push({ question_id: String(q.question_id), answer_id: 5 });
                    return;
                }

                let base = average > high ? 4 : (average > mid ? 3 : (average > low ? 2 : 1));

                if (groupName.includes("самоорганизац")) {
                    if (hwRatio >= 0.8 && !isUnstable) base = average > mid ? 4 : Math.min(base + 1, 3);
                    else if (hwRatio <= 0.4) base = Math.min(base, 2);
                    if (isUnstable && base > 2 && Math.random() < 0.5) base -= 1;
                } else if (groupName.includes("самообразован")) {
                    if (importantAvg > high && average > high) base = 4;
                    else if (importantAvg <= mid) base = Math.min(base, 2);
                    else if (importantAvg < (high - 0.3) && base === 4) base = 3;
                } else if (groupName.includes("саморегуляц")) {
                    if (isUnstable && base > 2) base -= 1;
                    if (unexcusedRatio >= 0.25 && base > 2) base -= 1;
                } else {
                    if (gradesCount >= 5 && average > mid && base < 4 && Math.random() < 0.4) {
                        base += 1;
                    } else if (gradesCount <= 2 && base > 2 && Math.random() < 0.3) {
                        base -= 1;
                    }
                }

                if (Math.random() < 0.1) {
                    if (base === 4) base = 3;
                    else if (base === 3) base = Math.random() < 0.5 ? 2 : 4;
                }

                answers.push({ question_id: String(q.question_id), answer_id: base });
            });
        });

        return answers;
    }

    function buildStudentNoteAndDispute(stats, settings) {
        const reasons = [];
        const absLimit = settings.absenceRatio ?? 0.5;
        const thresholds = [
            settings.highThreshold ?? 4.5,
            settings.midThreshold ?? 3.5,
            settings.lowThreshold ?? 2.5
        ];

        if (stats.absenceRatio > absLimit) {
            reasons.push(`Пропуски ${Math.round(stats.absenceRatio * 100)}% (выставлено «Затрудняюсь ответить»)`);
        }
        if (stats.gradesCount > 0 && stats.gradesCount <= 2) {
            reasons.push(`Мало оценок (${stats.gradesCount})`);
        }
        if (stats.isUnstable) {
            reasons.push("Есть двойки или большой разброс оценок");
        }
        if (stats.gradesCount > 0 && thresholds.some(t => Math.abs(stats.average - t) <= 0.1)) {
            reasons.push(`Пограничный балл (${stats.average.toFixed(2)})`);
        }

        return {
            disputed: reasons.length > 0,
            note: reasons.join("; ")
        };
    }

    async function processClassAPI(forceRecalc, currentClassName, settings) {
        const items = [];
        const groupId = getGroupIdFromUrl();
        if (!groupId) {
            throw new Error("Не удалось определить ID группы из адресной строки.");
        }

        const aid = getCookie('aid') || '14';
        sendPanelUpdate({ type: "progress", className: currentClassName, studentName: "Загрузка списка класса...", current: 0, total: 0 });

        const studentsUrl = `https://school.mos.ru/api/ej/core/teacher/v1/student_profiles?academic_year_id=${aid}&group_ids=${groupId}&with_groups=true&with_deleted=false&with_transferred=false&per_page=150&page=1`;
        const students = await apiFetch(studentsUrl);

        if (!Array.isArray(students) || students.length === 0) {
            return { processed: 0, alreadySet: 0, skipped: 0, aborted: false, items };
        }

        const firstStudent = students[0];
        const groupObj = (firstStudent.groups || []).find(g => String(g.id) === String(groupId));
        if (!groupObj) {
            throw new Error("Не удалось найти метаданные предмета для группы " + groupId);
        }

        const subjectId = groupObj.subject_id;
        const classLevelId = firstStudent.class_unit?.class_level_id || firstStudent.class_level;
        const schoolId = firstStudent.school_id;
        const educationLevelId = firstStudent.education_level || 2;
        const { begin: fallbackBegin, end: fallbackEnd } = getFallbackAcademicYear();
        const beginDate = groupObj.begin_date || fallbackBegin;
        const endDate = groupObj.end_date || fallbackEnd;

        const marksUrl = `https://school.mos.ru/api/ej/core/teacher/v1/marks?group_ids=${groupId}&subject_id=${subjectId}&class_level_id=${classLevelId}&lesson_date_from=${beginDate}&lesson_date_to=${endDate}&with_non_numeric_entries=true&per_page=1000&page=1`;
        const attendancesUrl = `https://school.mos.ru/api/ej/core/teacher/v1/attendances?group_ids=${groupId}&class_level_id=${classLevelId}&academic_year_id=${aid}&start_at=${beginDate}&stop_at=${endDate}&page=1&per_page=1000`;
        const controlFormsUrl = `https://school.mos.ru/api/ej/core/teacher/v1/control_forms?academic_year_id=${aid}&school_id=${schoolId}&subject_id=${subjectId}&with_grade_system=true&with_deleted=false&education_level_id=${educationLevelId}&page=1&per_page=1000`;

        const [marks, attendances, controlForms] = await Promise.all([
            apiFetch(marksUrl),
            apiFetch(attendancesUrl),
            apiFetch(controlFormsUrl)
        ]);

        const hwControlFormIds = new Set();
        const importantControlFormIds = new Set();

        (controlForms || []).forEach(cf => {
            const name = (cf.name || cf.short_name || "").toLowerCase();
            if (name.includes("цдз") || name.includes("цифров")) hwControlFormIds.add(cf.id);
            if (IMPORTANT_KEYWORDS.some(kw => name.includes(kw))) importantControlFormIds.add(cf.id);
        });

        const allLessonIds = new Set();
        (marks || []).forEach(m => { if (m.schedule_lesson_id) allLessonIds.add(m.schedule_lesson_id); });
        (attendances || []).forEach(a => { if (a.schedule_lesson_id) allLessonIds.add(a.schedule_lesson_id); });
        const totalLessons = allLessonIds.size;

        let processedCount = 0;
        let alreadySetCount = 0;
        let skippedCount = 0;

        for (let i = 0; i < students.length; i++) {
            await waitIfPaused();
            if (window.meshRobotStopRequested) {
                return { processed: processedCount, alreadySet: alreadySetCount, skipped: skippedCount, aborted: true, items };
            }

            const student = students[i];
            const studentName = student.short_name || student.user_name || `Ученик #${i + 1}`;
            sendPanelUpdate({
                type: "progress",
                className: currentClassName,
                studentName,
                current: i + 1,
                total: students.length
            });

            if (!student.person_id) {
                skippedCount++;
                items.push({ className: currentClassName, student: studentName, status: "no_data", disputed: true, avg: null, absencePct: null, note: "Нет person_id в МЭШ" });
                continue;
            }

            const periodsData = await apiFetch(`https://school.mos.ru/api/soft_skills/v1/periods?student_person_id=${student.person_id}`);
            const currentPeriod = (periodsData.periods || []).find(p => p.is_current);

            if (!currentPeriod) {
                skippedCount++;
                items.push({ className: currentClassName, student: studentName, status: "no_data", disputed: true, avg: null, absencePct: null, note: "Нет активного периода оценивания" });
                continue;
            }

            if (currentPeriod.exist_teacher_answer && !forceRecalc) {
                alreadySetCount++;
                items.push({ className: currentClassName, student: studentName, status: "skipped", disputed: false, avg: null, absencePct: null, note: "Оценки уже стояли" });
                continue;
            }

            const studentMarks = (marks || []).filter(m => m.student_profile_id === student.id && !m.deleted_by);
            const studentAttendances = (attendances || []).filter(a => a.student_profile_id === student.id);

            let grades = [];
            let weightedSum = 0;
            let totalWeight = 0;
            let importantGrades = [];
            let hwTotal = 0;
            let hwCompleted = 0;

            studentMarks.forEach(m => {
                const numericVal = m.values?.[0]?.grade?.five;
                const weight = m.weight || 1;
                const isHw = hwControlFormIds.has(m.control_form_id);
                const isImportant = weight > 1 || importantControlFormIds.has(m.control_form_id);

                if (isHw) {
                    hwTotal++;
                    if (numericVal != null) hwCompleted++;
                }

                if (numericVal != null) {
                    grades.push(numericVal);
                    weightedSum += numericVal * weight;
                    totalWeight += weight;
                    if (isImportant) importantGrades.push(numericVal);
                }
            });

            const totalAbsences = studentAttendances.length;
            const unexcusedAbsences = studentAttendances.filter(a => a.absence_reason_id === 2 || !a.nonattendance_reason_id).length;

            if (grades.length === 0 && totalAbsences === 0) {
                skippedCount++;
                items.push({ className: currentClassName, student: studentName, status: "no_data", disputed: true, avg: null, absencePct: 0, note: "Нет оценок и пропусков" });
                continue;
            }

            const average = totalWeight > 0 ? (weightedSum / totalWeight) : 0;
            const hwRatio = hwTotal > 0 ? (hwCompleted / hwTotal) : 1.0;
            const absenceRatio = totalLessons > 0 ? (totalAbsences / totalLessons) : 0;
            const unexcusedRatio = totalLessons > 0 ? (unexcusedAbsences / totalLessons) : 0;
            const hasTwos = grades.some(g => g <= 2);
            const spread = grades.length > 1 ? (Math.max(...grades) - Math.min(...grades)) : 0;
            const isUnstable = hasTwos || spread >= 2;
            const importantAvg = importantGrades.length > 0
                ? importantGrades.reduce((a, b) => a + b, 0) / importantGrades.length
                : average;

            const answers = calculateAnswers({
                average,
                gradesCount: grades.length,
                hwRatio,
                absenceRatio,
                unexcusedRatio,
                isUnstable,
                importantAvg
            }, settings, STANDARD_QUESTIONS);

            await apiFetch("https://school.mos.ru/api/soft_skills/v1/survey", {
                method: "POST",
                body: JSON.stringify({
                    student_person_id: student.person_id,
                    period_id: currentPeriod.period_id,
                    answers
                })
            });

            const check = buildStudentNoteAndDispute({ average, gradesCount: grades.length, absenceRatio, isUnstable }, settings);
            items.push({
                className: currentClassName,
                student: studentName,
                status: "success",
                disputed: check.disputed,
                avg: grades.length > 0 ? Number(average.toFixed(2)) : null,
                absencePct: Math.round(absenceRatio * 100),
                note: check.note
            });

            console.log(`[МЭШ Ассистент] Выставлено: ${studentName} (ср. ${average.toFixed(2)}, пропуски ${(absenceRatio * 100).toFixed(0)}%)`);
            processedCount++;
            await delay(250);
            await waitIfPaused();
            if (window.meshRobotStopRequested) {
                return { processed: processedCount, alreadySet: alreadySetCount, skipped: skippedCount, aborted: true, items };
            }
        }

        return { processed: processedCount, alreadySet: alreadySetCount, skipped: skippedCount, aborted: false, items };
    }

    async function processClassUI(forceRecalc, currentClassName, settings) {
        const items = [];
        const studentSpans = document.querySelectorAll("tbody span[title]");
        if (studentSpans.length === 0) {
            return { processed: 0, alreadySet: 0, skipped: 0, aborted: false, items };
        }

        const allLessonIds = new Set();
        const hwLessonIds = [];
        const importantLessonIds = [];

        Array.from(document.querySelectorAll('th')).forEach(header => {
            const text = header.textContent.toLowerCase();
            const div = header.querySelector('div[data-test-component]');
            if (!div) return;

            const parts = div.getAttribute("data-test-component").split("_");
            if (parts.length < 2) return;

            const match = parts[0].match(/\d+/);
            if (!match) return;
            const lessonId = match[0];

            allLessonIds.add(lessonId);
            if (text.includes("цдз")) hwLessonIds.push(lessonId);
            if (IMPORTANT_KEYWORDS.some(kw => text.includes(kw))) importantLessonIds.push(lessonId);
        });

        const totalLessons = allLessonIds.size;
        let alreadySetCount = 0;
        let processedCount = 0;
        let skippedCount = 0;

        for (let i = 0; i < studentSpans.length; i++) {
            await waitIfPaused();
            if (window.meshRobotStopRequested) {
                return { processed: processedCount, alreadySet: alreadySetCount, skipped: skippedCount, aborted: true, items };
            }

            const span = studentSpans[i];
            const studentName = span.getAttribute("title") || span.textContent.trim();

            sendPanelUpdate({
                type: "progress",
                className: currentClassName,
                studentName,
                current: i + 1,
                total: studentSpans.length
            });

            const row = span.closest('tr');
            if (!row) {
                skippedCount++;
                items.push({ className: currentClassName, student: studentName, status: "no_data", disputed: true, avg: null, absencePct: null, note: "Не удалось прочитать строку ученика" });
                continue;
            }

            const cells = row.querySelectorAll('td');
            const gradeText = cells[cells.length - 1].textContent.trim().replace(',', '.');
            const grade = (gradeText && gradeText !== "-") ? parseFloat(gradeText) : 0;

            const grades = [];
            const importantGrades = [];
            let hwCompleted = 0;
            let unexcusedAbsences = 0;
            let totalAbsences = 0;

            row.querySelectorAll('div[data-test-component^="markCell-"]').forEach(div => {
                const text = div.textContent.trim();
                const lowerText = text.toLowerCase();
                const hasGrade = ['5', '4', '3', '2', '1'].includes(text);

                if (hasGrade) {
                    grades.push(parseInt(text, 10));
                } else if (['н', 'нв'].includes(lowerText)) {
                    unexcusedAbsences++;
                    totalAbsences++;
                } else if (['нб', 'б', 'у'].includes(lowerText)) {
                    totalAbsences++;
                }

                const attr = div.getAttribute("data-test-component");
                if (attr) {
                    const parts = attr.split("_");
                    if (parts.length >= 3) {
                        const lessonId = parts[1];
                        if (hwLessonIds.includes(lessonId)) {
                            if (hasGrade || (text !== "" && !['н', 'нб', 'нв', 'б', 'у'].includes(lowerText))) {
                                hwCompleted++;
                            }
                        }
                        if (hasGrade && importantLessonIds.includes(lessonId)) {
                            importantGrades.push(parseInt(text, 10));
                        }
                    }
                }
            });

            if (grades.length === 0 && totalAbsences === 0) {
                skippedCount++;
                items.push({ className: currentClassName, student: studentName, status: "no_data", disputed: true, avg: null, absencePct: 0, note: "Нет оценок и пропусков" });
                continue;
            }

            const hwRatio = hwLessonIds.length > 0 ? hwCompleted / hwLessonIds.length : 1.0;
            const absenceRatio = totalLessons > 0 ? totalAbsences / totalLessons : 0;
            const unexcusedRatio = totalLessons > 0 ? unexcusedAbsences / totalLessons : 0;
            const hasTwos = grades.includes(2) || grades.includes(1);
            const spread = grades.length > 1 ? Math.max(...grades) - Math.min(...grades) : 0;
            const isUnstable = hasTwos || spread >= 2;
            const importantAvg = importantGrades.length > 0
                ? importantGrades.reduce((a, b) => a + b, 0) / importantGrades.length
                : grade;

            const answers = calculateAnswers({
                average: grade,
                gradesCount: grades.length,
                hwRatio,
                absenceRatio,
                unexcusedRatio,
                isUnstable,
                importantAvg
            }, settings, STANDARD_QUESTIONS);

            span.click();
            await delay(800);

            if (window.meshRobotStopRequested) {
                closeStudentModal();
                return { processed: processedCount, alreadySet: alreadySetCount, skipped: skippedCount, aborted: true, items };
            }

            const revalBtn = getElementByExactText('button', 'Повторно оценить учебные умения');
            const evalBtn = getElementByExactText('button', 'Оценить учебные умения');

            if (revalBtn) {
                if (forceRecalc) {
                    revalBtn.click();
                } else {
                    alreadySetCount++;
                    items.push({
                        className: currentClassName,
                        student: studentName,
                        status: "skipped",
                        disputed: false,
                        avg: grades.length > 0 ? Number(grade.toFixed(2)) : null,
                        absencePct: Math.round(absenceRatio * 100),
                        note: "Оценки уже стояли"
                    });
                    closeStudentModal();
                    await delay(400);
                    continue;
                }
            } else if (evalBtn) {
                evalBtn.click();
            } else {
                skippedCount++;
                items.push({
                    className: currentClassName,
                    student: studentName,
                    status: "no_data",
                    disputed: true,
                    avg: grades.length > 0 ? Number(grade.toFixed(2)) : null,
                    absencePct: Math.round(absenceRatio * 100),
                    note: "Кнопка оценивания недоступна"
                });
                closeStudentModal();
                await delay(400);
                continue;
            }

            await delay(1500);

            if (window.meshRobotStopRequested) {
                closeStudentModal();
                return { processed: processedCount, alreadySet: alreadySetCount, skipped: skippedCount, aborted: true, items };
            }

            const options2 = Array.from(document.querySelectorAll('label')).filter(l => l.textContent.includes('Редко'));
            const numQuestions = Math.min(options2.length, answers.length);

            if (numQuestions === 0) {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
                await delay(400);
                skippedCount++;
                items.push({
                    className: currentClassName,
                    student: studentName,
                    status: "no_data",
                    disputed: true,
                    avg: grades.length > 0 ? Number(grade.toFixed(2)) : null,
                    absencePct: Math.round(absenceRatio * 100),
                    note: "Форма оценивания не открылась"
                });
                continue;
            }

            for (let q = 0; q < numQuestions; q++) {
                if (q === 0) {
                    const dummys = Array.from(document.querySelectorAll('label')).filter(l => l.textContent.includes('Почти никогда'));
                    if (dummys.length > 0) {
                        dummys[0].click();
                        await delay(150);
                    }
                }

                const targetText = SKILL_LABELS[answers[q].answer_id];
                const targets = Array.from(document.querySelectorAll('label')).filter(l => l.textContent.includes(targetText));

                if (targets[q]) {
                    targets[q].click();
                    await delay(250);
                }
            }

            await delay(500);
            const saveBtn = getElementByExactText('button', 'Сохранить');
            if (saveBtn) saveBtn.click();

            await delay(2000);

            const check = buildStudentNoteAndDispute({ average: grade, gradesCount: grades.length, absenceRatio, isUnstable }, settings);
            items.push({
                className: currentClassName,
                student: studentName,
                status: "success",
                disputed: check.disputed,
                avg: grades.length > 0 ? Number(grade.toFixed(2)) : null,
                absencePct: Math.round(absenceRatio * 100),
                note: check.note
            });

            if (window.meshRobotStopRequested) {
                closeStudentModal();
                processedCount++;
                return { processed: processedCount, alreadySet: alreadySetCount, skipped: skippedCount, aborted: true, items };
            }

            const closeBtn = getElementByExactText('button', 'Закрыть');
            if (closeBtn) closeBtn.click();

            processedCount++;
            await delay(800);
            await waitIfPaused();
            if (window.meshRobotStopRequested) {
                return { processed: processedCount, alreadySet: alreadySetCount, skipped: skippedCount, aborted: true, items };
            }
        }

        return { processed: processedCount, alreadySet: alreadySetCount, skipped: skippedCount, aborted: false, items };
    }

    window.MeshAssistants.skills = {
        title: "Учебные умения",
        processAPI: processClassAPI,
        processUI: processClassUI
    };
})();