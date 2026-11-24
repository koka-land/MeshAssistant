const lastSyncedStateByTab = new Map();

function isClassJournalUrl(url = "") {
    return url.startsWith("https://school.mos.ru/") &&
        /\/(?:journal\/my|grade)\/\d+/.test(url);
}

// ДОБАВЛЕНО (в начало, после isClassJournalUrl): единый хелпер выбора окна
function getActiveTabQuery(windowId) {
    return windowId !== undefined
        ? { active: true, windowId }
        : { active: true, currentWindow: true };
}

function notifyTabContext(tab, force = false) {
    if (!tab?.id) return;

    const url = tab.url || "";
    const onJournal = isClassJournalUrl(url);
    const cacheKey = `${onJournal}:${url}`;

    if (!force && lastSyncedStateByTab.get(tab.id) === cacheKey) {
        return;
    }
    lastSyncedStateByTab.set(tab.id, cacheKey);

    chrome.runtime.sendMessage({
        target: "sidepanel",
        type: "context_changed",
        windowId: tab.windowId, // ДОБАВЛЕНО: метка окна
        url,
        isJournal: onJournal
    }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
    if (chrome.sidePanel?.setPanelBehavior) {
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(err => {
            console.error("[МЭШ Ассистент] Ошибка настройки Side Panel:", err);
        });
    }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs.get(tabId, (tab) => {
        if (!chrome.runtime.lastError && tab) {
            notifyTabContext(tab, true);
        }
    });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
        notifyTabContext({ ...tab, id: tabId, url: changeInfo.url }, false);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    lastSyncedStateByTab.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action === "reload_active_tab") {
        // ИЗМЕНЕНО: используем windowId вместо currentWindow
        chrome.tabs.query(getActiveTabQuery(message.windowId), (tabs) => {
            const tab = tabs?.[0];
            if (tab?.id) {
                chrome.tabs.reload(tab.id);
            }
            sendResponse?.({ ok: Boolean(tab?.id) });
        });
        return true;
    }

    if (message?.action === "open_url" && message.url) {
        const targetUrl = message.url;
        const targetWindowId = message.windowId;
        const queryOpts = targetWindowId !== undefined
            ? { windowId: targetWindowId }
            : { currentWindow: true };

        chrome.tabs.query(queryOpts, (tabs) => {
            const existing = (tabs || []).find(t => (t.url || "").startsWith(targetUrl));
            if (existing?.id) {
                chrome.tabs.update(existing.id, { active: true });
            } else {
                const createOpts = { url: targetUrl, active: true };
                if (targetWindowId !== undefined) {
                    createOpts.windowId = targetWindowId;
                }
                chrome.tabs.create(createOpts);
            }
            sendResponse?.({ ok: true });
        });
        return true;
    }

    if (message?.target === "content") {
        const isContextCheck = message.payload?.action === "check_context";

        // ИЗМЕНЕНО: ищем активную вкладку строго в окне, откуда пришла команда
        chrome.tabs.query(getActiveTabQuery(message.windowId), async (tabs) => {
            const tab = tabs?.[0];
            const replyWindowId = message.windowId ?? tab?.windowId;

            if (!tab?.id || !tab.url?.includes("school.mos.ru")) {
                if (!isContextCheck) {
                    chrome.runtime.sendMessage({
                        target: "sidepanel",
                        type: "error",
                        windowId: replyWindowId,
                        title: "Нет активного журнала МЭШ",
                        summary: "Откройте страницу электронного журнала на school.mos.ru и повторите запуск."
                    }).catch(() => {});
                } else {
                    chrome.runtime.sendMessage({
                        target: "sidepanel",
                        type: "page_context",
                        windowId: replyWindowId,
                        isJournalPage: false,
                        isClassJournal: false,
                        className: ""
                    }).catch(() => {});
                }
                sendResponse?.({ ok: false });
                return;
            }

            try {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ["content.js"]
                });

                chrome.tabs.sendMessage(tab.id, message.payload, (response) => {
                    if (chrome.runtime.lastError) {
                        if (isContextCheck) {
                            chrome.runtime.sendMessage({
                                target: "sidepanel",
                                type: "page_context",
                                windowId: replyWindowId,
                                isJournalPage: isClassJournalUrl(tab.url),
                                isClassJournal: false,
                                className: ""
                            }).catch(() => {});
                        }
                        sendResponse?.({ ok: false });
                        return;
                    }

                    if (isContextCheck && response) {
                        chrome.runtime.sendMessage({
                            target: "sidepanel",
                            type: "page_context",
                            windowId: replyWindowId,
                            ...response
                        }).catch(() => {});
                    }
                    sendResponse?.({ ok: true });
                });
            } catch (err) {
                if (!isContextCheck) {
                    chrome.runtime.sendMessage({
                        target: "sidepanel",
                        type: "error",
                        windowId: replyWindowId,
                        title: "Ошибка подключения к странице",
                        summary: err.message
                    }).catch(() => {});
                }
                sendResponse?.({ ok: false });
            }
        });
        return true;
    }

    // ИЗМЕНЕНО (в самом конце): прикрепляем windowId отправителя при ретрансляции
    if (message?.target === "sidepanel") {
        chrome.runtime.sendMessage({
            ...message,
            windowId: message.windowId ?? sender.tab?.windowId
        }).catch(() => {});
    }
});