// ReplyTrack — the one service worker. The parts live in bg/ (each file says what it keeps):
//   bg/common.js     helpers, the two logs ([Outreach] / [ReplySync])
//   bg/sheet.js      your own Google Sheet (Apps Script web app, secret key, write outbox)
//   bg/lock.js       one thing at a time on LinkedIn
//   bg/linkedin.js   the minimized LinkedIn worker tab (outreach.js runs there)
//   bg/outreach.js   connection requests from your sheet's rows
//   bg/replysync.js  replies from LinkedIn messaging → Response / Notes
//   bg/accepted.js   twice a day: who accepted → "Accepted but not replied"
//   bg/admin.js      Admin Replies: the "To send" list and sending one, when you say so
//   bg/control.js    Pause everything / Start again
importScripts(
	"shared.js",
	"bg/common.js",
	"bg/sheet.js",
	"bg/lock.js",
	"bg/linkedin.js",
	"bg/outreach.js",
	"bg/replysync.js",
	"bg/accepted.js",
	"bg/admin.js",
	"bg/control.js"
);

const DASHBOARD = "dashboard.html";
const TICK_ALARM = "rt-tick"; // every 15 min: accepted check due? sheet writes waiting?
const TICK_MINUTES = 15;
const IDLE_DETECTION_SECONDS = 5 * 60; // "idle" = no mouse/keyboard for 5 min (sleep and lock always count)

// ---------------------------------------------------------------------------
// Messages: one router for the popup, the pages and content.js. Types it doesn't know
// get no answer (they're meant for a tab).
// ---------------------------------------------------------------------------
const HANDLERS = {
	// Outreach (popup, outreach page, settings)
	OR_START: m => Outreach.startRun(m.job === "check" ? "check" : "send", { pastCap: !!m.pastCap, confirmed: !!m.confirmed }),
	OR_STOP: () => Outreach.stopRun().then(() => ({ ok: true })),
	OR_LOAD: () => Outreach.loadSheet(),
	OR_COUNTS: () => Outreach.counts(),
	OR_IMPORT: m => Outreach.importHistory(m.entries),
	AC_CHECK: () => Accepted.run("Check now button"),
	// Admin Replies (popup "To send")
	AD_REFRESH: m => Admin.refresh({ force: !!m.force }),
	AD_SEND: m => Admin.send(m),
	AD_CANCEL: m => Admin.cancel(m),
	AD_SKIP: m => Admin.skip(m),
	AD_BY_HAND: m => Admin.sentByHand(m),
	AD_UNCLEAR: m => Admin.answerUnclear(m),
	// Everything
	RT_PAUSE: () => Control.pause(),
	RT_RESUME: () => Control.resume(),
};
// Reply sync (content.js, popup, settings) — the message names ReplyTrack always used.
for (const t of ReplySync.TYPES) HANDLERS[t] = (m, sender) => ReplySync.handle(m, sender);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	const handler = msg && HANDLERS[msg.type];
	if (!handler) return false;
	Promise.resolve()
		.then(() => handler(msg, sender))
		.then(sendResponse, err => {
			console.warn(`[ReplySync] Error handling "${msg.type}":`, err);
			sendResponse({ ok: false, error: String((err && err.message) || err) });
		});
	return true; // keep the channel open for the async answer
});

// ---------------------------------------------------------------------------
// When the lock is free again, whatever waited goes now.
// ---------------------------------------------------------------------------
Lock.onRelease(owner => ReplySync.onLockFree(owner));
Lock.onRelease(owner => Accepted.onLockFree(owner));

// A cleared Admin Reply (or a reply written) changes the "To send" list.
Sheet.afterWrite(job => {
	if (job.action === "clearAdmin" || job.action === "addReplies") Admin.refresh({ force: true }).catch(e => console.warn("[ReplySync]", e));
});

// ---------------------------------------------------------------------------
// The dashboard: the toolbar icon opens it as a full page — or switches to its tab if
// it's already open. section: "settings", "tosend", … (the part after #).
// ---------------------------------------------------------------------------
async function openDashboard(section) {
	const url = chrome.runtime.getURL(DASHBOARD);
	const target = section ? `${url}#${section}` : url;
	let tab = null;
	try {
		const ctx = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
		const c = ctx.find(x => String(x.documentUrl || "").startsWith(url) && x.tabId >= 0);
		if (c) tab = { id: c.tabId, windowId: c.windowId };
	} catch (e) {
		tab = (await chrome.tabs.query({ url: `${url}*` }).catch(() => []))[0] || null;
	}
	if (!tab) return chrome.tabs.create({ url: target });
	await chrome.tabs.update(tab.id, { active: true, ...(section ? { url: target } : {}) });
	if (tab.windowId >= 0) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
}
chrome.action.onClicked.addListener(() => openDashboard().catch(e => console.warn("[ReplySync] dashboard:", e)));

// ---------------------------------------------------------------------------
// Alarms, startup, install, idle
// ---------------------------------------------------------------------------
async function ensureAlarms() {
	await ReplySync.ensureAlarm();
	if (!(await chrome.alarms.get(TICK_ALARM))) chrome.alarms.create(TICK_ALARM, { periodInMinutes: TICK_MINUTES, delayInMinutes: 1 });
}

const ALARM_REASONS = {
	[ReplySync.ALARM]: "20-minute alarm",
	[ReplySync.WAKE_ALARM]: "computer active again",
	[ReplySync.RETRY_ALARM]: "retry after no internet",
};
chrome.alarms.onAlarm.addListener(alarm => {
	const reason = ALARM_REASONS[alarm.name];
	if (reason) {
		ReplySync.ensureSyncTab(reason).catch(e => console.warn("[ReplySync] alarm:", e));
		if (alarm.name === ReplySync.ALARM) Admin.refresh().catch(e => console.warn("[ReplySync] To send:", e));
	}
	if (alarm.name === TICK_ALARM) {
		Accepted.maybeRun("schedule").catch(e => console.warn("[Outreach] accepted check:", e));
		Sheet.flush().catch(e => console.warn("[ReplySync] outbox:", e));
	}
	if (alarm.name === Sheet.RETRY_ALARM) Sheet.flush().catch(e => console.warn("[ReplySync] outbox:", e));
});

chrome.runtime.onStartup.addListener(() => {
	ensureAlarms().catch(e => console.warn("[ReplySync] alarm:", e));
	ReplySync.ensureSyncTab("browser startup").catch(e => console.warn("[ReplySync] startup:", e));
});

chrome.runtime.onInstalled.addListener(async details => {
	try {
		await ensureAlarms();
		const settings = await Sheet.settings();
		if (details.reason === "install" && !Sheet.configured(settings)) await openDashboard("settings");
		else await ReplySync.ensureSyncTab(`extension ${details.reason}`);
	} catch (e) {
		console.warn("[ReplySync] onInstalled:", e);
	}
});

// Woke from sleep, unlocked, or back at the keyboard after 5+ minutes away:
// sync 30 seconds later (gives Wi-Fi time to reconnect); a missed accepted check runs too.
chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS);
chrome.idle.onStateChanged.addListener(async state => {
	if (state !== "active") return;
	if (await ReplySync.isStopped()) return console.log("[ReplySync] Computer is active again — sync is stopped, so nothing happens.");
	console.log("[ReplySync] Computer is active again — syncing in 30 seconds.");
	chrome.alarms.create(ReplySync.WAKE_ALARM, { delayInMinutes: ReplySync.WAKE_DELAY_MINUTES });
	setTimeout(() => Accepted.maybeRun("computer active again").catch(() => {}), 60000);
});

// Signed in to LinkedIn again: the "logged out" banner goes.
chrome.cookies.onChanged.addListener(c => {
	if (!c.removed && c.cookie.name === "li_at" && /(^|\.)linkedin\.com$/.test(c.cookie.domain)) clearLoggedOut();
});

// The service worker can be restarted at any time.
ensureAlarms().catch(e => console.warn("[ReplySync] alarm:", e));
Outreach.resumeAfterRestart().catch(e => console.warn("[Outreach] resume:", e));
Admin.recover().catch(e => console.warn("[ReplySync] recover:", e));
setTimeout(() => {
	if (!Outreach.isRunning()) LI.closeWorkerWindowIfIdle().catch(() => {});
	Sheet.flush().catch(() => {});
	Admin.rebuild().catch(() => {}); // the badge
}, 8000);
