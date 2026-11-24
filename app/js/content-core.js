(() => {
    if (window.MeshCore) return;

    window.MeshAssistants = window.MeshAssistants || {};
    window.meshRobotPaused = false;
    window.meshRobotStopRequested = false;
    window.isMeshRobotRunning = false;

    const delay = ms => new Promise(res => setTimeout(res, ms));

    const DEFAULT_SETTINGS = {
        autoOpenJournalPanel: true,
        highThreshold: 4.5,
        midThreshold: 3.5,
        lowThreshold: 2.5,
        absenceRatio: 0.5
    };

    // --- Определение темы МЭШ ---

    function parseRgbColor(colorStr) {
        if (!colorStr) return null;
        const match = colorStr.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/i);
        if (!match) return null;
        const alpha = match[4] !== undefined ? parseFloat(match[4]) : 1;
        if (Number.isNaN(alpha) || alpha <= 0.05) return null;
        return {
            r: Math.min(255, Math.max(0, Math.round(parseFloat(match[1])))),
            g: Math.min(255, Math.max(0, Math.round(parseFloat(match[2])))),
            b: Math.min(255, Math.max(0, Math.round(parseFloat(match[3]))))
        };
    }

    function rgbToCss({ r, g, b }) {
        return `rgb(${r}, ${g}, ${b})`;
    }

    function rgbToRgba({ r, g, b }, alpha) {
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    function getLuminance({ r, g, b }) {
        const toLinear = v => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
    }

    function getSaturation({ r, g, b }) {
        const max = Math.max(r, g, b) / 255;
        const min = Math.min(r, g, b) / 255;
        if (max === min) return 0;
        const l = (max + min) / 2;
        const d = max - min;
        return l > 0.5 ? d / (2 - max - min) : d / (max + min);
    }

    function extractJournalTheme() {
        try {
            const leftMenu =
                document.querySelector("aside, nav, [class*='sidebar' i], [class*='Sidebar' i], [class*='leftMenu' i], [class*='left-menu' i]") ||
                null;
            if (!leftMenu) return null;

            const menuStyle = window.getComputedStyle(leftMenu);
            let effectiveMenuBg = parseRgbColor(menuStyle.backgroundColor);

            if (!effectiveMenuBg) {
                for (const child of leftMenu.querySelectorAll("div, ul, section")) {
                    const c = parseRgbColor(window.getComputedStyle(child).backgroundColor);
                    const rect = child.getBoundingClientRect();
                    if (c && rect.width > 120 && rect.height > 200) {
                        effectiveMenuBg = c;
                        break;
                    }
                }
            }
            if (!effectiveMenuBg) return null;

            const isMenuDark = getLuminance(effectiveMenuBg) < 0.35;
            let activeAccentRgb = null;

            const activeSelectors = [
                "[aria-current='page']", "[aria-selected='true']",
                ".active", "[class*='active' i]", "[class*='selected' i]", "[class*='current' i]"
            ];

            for (const sel of activeSelectors) {
                for (const item of leftMenu.querySelectorAll(sel)) {
                    const rect = item.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) continue;
                    const bg = parseRgbColor(window.getComputedStyle(item).backgroundColor);
                    if (bg && getSaturation(bg) > 0.25) {
                        const lum = getLuminance(bg);
                        if (lum > 0.03 && lum < 0.85) {
                            activeAccentRgb = bg;
                            break;
                        }
                    }
                }
                if (activeAccentRgb) break;
            }

            if (!activeAccentRgb) {
                for (const el of leftMenu.querySelectorAll("a, button, li, div, span")) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) continue;
                    const bg = parseRgbColor(window.getComputedStyle(el).backgroundColor);
                    if (bg && getSaturation(bg) > 0.35) {
                        const lum = getLuminance(bg);
                        if (lum > 0.04 && lum < 0.75) {
                            activeAccentRgb = bg;
                            break;
                        }
                    }
                }
            }

            const clamp = v => Math.min(255, Math.max(0, Math.round(v)));
            const shift = (rgb, d) => ({ r: clamp(rgb.r + d), g: clamp(rgb.g + d), b: clamp(rgb.b + d) });

            const finalBg = isMenuDark ? shift(effectiveMenuBg, -6) : shift(effectiveMenuBg, 4);
            const finalSurface = isMenuDark ? shift(effectiveMenuBg, 10) : { r: 255, g: 255, b: 255 };
            const finalText = isMenuDark ? { r: 232, g: 234, b: 237 } : { r: 32, g: 33, b: 36 };
            const finalPrimary = activeAccentRgb || (isMenuDark ? { r: 92, g: 158, b: 255 } : { r: 26, g: 115, b: 232 });
            const primaryHover = isMenuDark ? shift(finalPrimary, 22) : shift(finalPrimary, -20);

            return {
                mode: isMenuDark ? "dark" : "light",
                vars: {
                    "--bg": rgbToCss(finalBg),
                    "--surface": rgbToCss(finalSurface),
                    "--text": rgbToCss(finalText),
                    "--primary": rgbToCss(finalPrimary),
                    "--primary-hover": rgbToCss(primaryHover),
                    "--primary-soft": rgbToRgba(finalPrimary, isMenuDark ? 0.22 : 0.14),
                    "--on-primary": getLuminance(finalPrimary) > 0.45 ? "#111318" : "#ffffff"
                }
            };
        } catch {
            return null;
        }
    }

    // --- Настройки, контекст и отчёты ---

    async function getSettings() {
        try {
            if (!chrome?.storage?.local) return { ...DEFAULT_SETTINGS };
            const data = await chrome.storage.local.get({ settings: DEFAULT_SETTINGS });
            return { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
        } catch {
            return { ...DEFAULT_SETTINGS };
        }
    }

    async function saveReportToHistory(report) {
        try {
            if (!chrome?.storage?.local) return;
            const { reportHistory = [] } = await chrome.storage.local.get("reportHistory");
            const updated = [report, ...reportHistory].slice(0, 5);
            await chrome.storage.local.set({ reportHistory: updated });
        } catch (e) {
            console.warn("[МЭШ Ассистент] Не удалось сохранить отчёт:", e);
        }
    }

    function sendPanelUpdate(data) {
        try {
            chrome.runtime.sendMessage({ target: "sidepanel", ...data }).catch(() => {});
        } catch {}
    }

    function detectJournalContext() {
        const isMosHost = window.location.hostname === "school.mos.ru";
        const pathname = window.location.pathname;
        const onSpecificClassUrl = isMosHost && /\/(?:journal\/my|grade)\/\d+/.test(pathname);
        const onJournalSection = isMosHost && (pathname.includes("/journal") || pathname.includes("/grade"));
        const classSelector = document.querySelector('[data-test-component="leftControlHeadSelectGroup-selectSingleWrapper"]');
        const hasClassSelector = Boolean(classSelector);
        const isClassJournal = onSpecificClassUrl || (onJournalSection && hasClassSelector);

        return {
            isJournalPage: onJournalSection,
            isClassJournal,
            className: hasClassSelector ? classSelector.textContent.trim() : "",
            journalTheme: isClassJournal ? extractJournalTheme() : null
        };
    }

    let contextCheckTimers = [];

    function reportJournalContext(withRetries = false) {
        contextCheckTimers.forEach(id => clearTimeout(id));
        contextCheckTimers = [];

        const sendCurrent = () => {
            sendPanelUpdate({ type: "page_context", ...detectJournalContext() });
        };

        sendCurrent();
        if (withRetries) {
            [600, 1400, 2500].forEach(ms => {
                contextCheckTimers.push(setTimeout(sendCurrent, ms));
            });
        }
    }

    // --- API, DOM, пауза и переключение классов ---

    function getCookie(name) {
        const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
        return match ? decodeURIComponent(match[2]) : null;
    }

    function getApiHeaders() {
        const token = getCookie('aupd_token');
        const profileId = getCookie('profile_id');
        const aid = getCookie('aid') || '14';
        const subsystemId = getCookie('subsystem_id') || '9';

        if (!token || !profileId) {
            throw new Error("Не найдены данные авторизации (aupd_token / profile_id). Обновите страницу журнала.");
        }

        return {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "profile-id": profileId,
            "aid": aid,
            "x-mes-subsystem": "teacherweb",
            "x-mes-hostid": subsystemId,
            "x-mes-roleid": subsystemId
        };
    }

    async function apiFetch(url, options = {}) {
        const headers = getApiHeaders();
        if (!options.body) delete headers["Content-Type"];

        const res = await fetch(url, {
            ...options,
            headers: { ...headers, ...(options.headers || {}) },
            credentials: "include"
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`Ошибка API ${res.status} (${url}) ${errText}`);
        }
        return res.json();
    }

    function getGroupIdFromUrl() {
        const urlMatch = window.location.href.match(/(?:\/grade\/|\/journal\/|group_id[s]?=)(\d+)/);
        if (urlMatch) return urlMatch[1];

        const resources = performance.getEntriesByType('resource');
        for (let i = resources.length - 1; i >= 0; i--) {
            const match = resources[i].name.match(/group_id[s]?=(\d+)/);
            if (match) return match[1];
        }
        return null;
    }

    function getElementByExactText(tag, text) {
        return Array.from(document.querySelectorAll(tag)).find(el => el.textContent.trim() === text);
    }

    function closeStudentModal() {
        const titleEl = getElementByExactText('div', 'Информация об учащемся');
        if (titleEl?.parentElement) {
            const closeBtn = titleEl.parentElement.querySelector('button');
            if (closeBtn) {
                closeBtn.click();
                return;
            }
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    }

    async function waitIfPaused() {
        while (window.meshRobotPaused && !window.meshRobotStopRequested) {
            await delay(150);
        }
    }

    function closeOpenModalsOnStop() {
        try {
            const titleEl = getElementByExactText('div', 'Информация об учащемся');
            if (titleEl?.parentElement) {
                titleEl.parentElement.querySelector('button')?.click();
            }

            const explicitClose = getElementByExactText('button', 'Закрыть');
            if (explicitClose && explicitClose.offsetParent !== null) {
                explicitClose.click();
            }

            const ariaCloseButtons = document.querySelectorAll(
                '[role="dialog"] button[aria-label*="закрыт" i], [role="dialog"] button[aria-label*="close" i], [class*="modal"] button[aria-label*="закрыт" i], [class*="modal"] button[aria-label*="close" i]'
            );
            ariaCloseButtons.forEach(btn => {
                if (btn instanceof HTMLElement && btn.offsetParent !== null) btn.click();
            });

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
        } catch {}
    }

    async function switchToFirstClass() {
        const dropdownWrapper = document.querySelector('[data-test-component="leftControlHeadSelectGroup-selectSingleWrapper"]');
        if (!dropdownWrapper) return false;

        dropdownWrapper.click();
        await delay(1200);

        const options = Array.from(document.querySelectorAll('li, [role="option"]')).filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && !el.closest('nav') && !el.closest('header');
        });

        if (options.length === 0) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            return false;
        }

        options[0].click();
        await delay(3000);
        return true;
    }

    async function switchNextClass(currentClassName) {
        const dropdownWrapper = document.querySelector('[data-test-component="leftControlHeadSelectGroup-selectSingleWrapper"]');
        if (!dropdownWrapper) return false;

        dropdownWrapper.click();
        await delay(1200);

        const options = Array.from(document.querySelectorAll('li, [role="option"]')).filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && !el.closest('nav') && !el.closest('header');
        });

        if (options.length === 0) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            return false;
        }

        const currentIndex = options.findIndex(item => item.textContent.trim().includes(currentClassName));
        if (currentIndex !== -1 && currentIndex + 1 < options.length) {
            options[currentIndex + 1].click();
            await delay(3000);
            return true;
        }

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        return false;
    }

    window.MeshCore = {
        delay,
        DEFAULT_SETTINGS,
        getSettings,
        saveReportToHistory,
        sendPanelUpdate,
        detectJournalContext,
        reportJournalContext,
        getCookie,
        apiFetch,
        getGroupIdFromUrl,
        getElementByExactText,
        closeStudentModal,
        waitIfPaused,
        closeOpenModalsOnStop,
        switchToFirstClass,
        switchNextClass
    };
})();