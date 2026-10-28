// ReplyTrack dashboard — the one page (the toolbar icon opens it). This file: helpers and
// state shared by the sections, the top bar, the banner, the tabs and the theme. Each
// section (dash/overview.js, outreach.js, replies.js, tosend.js, settings.js) registers
// what it draws with onRender() — called on every storage change and once a second —
// and onChange() for work that should only happen when its data changes.
const S = globalThis.ORShared;
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const send = msg => chrome.runtime.sendMessage(msg).catch(e => ({ ok: false, error: e.message }));
const plural = (n, w, ws = w + "s") => `${Number(n || 0).toLocaleString()} ${n === 1 ? w : ws}`;
const fmtDur = s => (s < 90 ? `${Math.max(1, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const retryable = it => it.status === "failed" && (it.attempts || 0) < 3;
const isTodo = it => !it.done && (it.status === "pending" || retryable(it));
const startOfDay = (t = Date.now()) => new Date(new Date(t).setHours(0, 0, 0, 0)).getTime();
const startOfWeek = (t = Date.now()) => {
	const d = new Date(startOfDay(t));
	d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
	return d.getTime();
};
const clockOf = t => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
// "3:42 PM" today, "Oct 27, 3:42 PM" before
const timeOf = t => (t >= startOfDay() ? clockOf(t) : new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour12: false });
function ago(ts) {
	const s = Math.round((Date.now() - ts) / 1000);
	if (s < 60) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h} h ago`;
	return `${Math.round(h / 24)} days ago`;
}
const STALE_SYNC_MS = 3 * 60 * 1000; // same as bg/replysync.js
const BUSY = { outreach: "outreach", replysync: "the reply sync", accepted: "the accepted check", admin: "an Admin Reply", adminCheck: "the connection check" };

// Sets innerHTML only when it changed (keeps hover states and selections steady).
function setHTML(el, html) {
	if (el._html === html) return;
	el._html = html;
	el.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Icons (24×24, drawn with the text colour)
// ---------------------------------------------------------------------------
const svg = d => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
	sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
	moon: svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
	pause: svg('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'),
	play: svg('<path d="M7 5l12 7-12 7z"/>'),
	stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
	plus: svg('<path d="M12 5v14M5 12h14"/>'),
	send: svg('<path d="M21 3L10 14M21 3l-7 18-4-7-7-4z"/>'),
	refresh: svg('<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/>'),
	download: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
	inbox: svg('<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 3h6l1-3h5"/>'),
	clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
	chat: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
	users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>'),
	alert: svg('<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.01"/>'),
	check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
};
const empty = (icon, title, text) => `<div class="empty">${ICON[icon]}<b>${esc(title)}</b><span>${esc(text)}</span></div>`;

// ---------------------------------------------------------------------------
// State (what the service worker keeps in chrome.storage)
// ---------------------------------------------------------------------------
const KEYS = [
	"orRun",
	"orItems",
	"orSheet",
	"orSettings",
	"orLog",
	"rsStatus",
	"syncStopped",
	"rsToday",
	"rsLog",
	"rsRecent",
	"rtPaused",
	"rtLoggedOut",
	"rtSheetError",
	"rtOutbox",
	"rtActivity",
	"rtMember",
	"adList",
	"adJob",
	"adNote",
	"adRows",
	"acStatus",
	"acWeek",
];
const CFG_DEFAULTS = { tabName: "", scriptUrl: "", secretKey: "", useGoogleLogin: false };
let st = {};
let cfg = { ...CFG_DEFAULTS };
let counts = { today: 0, limit: 0 };
let nextSyncAt = 0;
const configured = () => !!(cfg.tabName && cfg.scriptUrl && cfg.secretKey);
const orSettings = () => ({ ...S.DEFAULTS, ...(st.orSettings || {}) });

const renderers = [];
const changeHooks = [];
const onRender = fn => renderers.push(fn);
const onChange = fn => changeHooks.push(fn);
function render() {
	for (const fn of [renderTop, renderBanner, ...renderers]) {
		try {
			fn();
		} catch (e) {
			console.error("[ReplyTrack] render:", e);
		}
	}
}

// ---------------------------------------------------------------------------
// Tabs (#overview, #outreach, #replies, #tosend, #settings)
// ---------------------------------------------------------------------------
const TABS = ["overview", "outreach", "replies", "tosend", "settings"];
let tab = "overview";
function showTab(name) {
	if (!TABS.includes(name)) name = "overview";
	const moved = tab !== name;
	tab = name;
	for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.tab === name);
	for (const id of TABS) $(`page-${id}`).classList.toggle("on", id === name); // "page-…": a section id equal to the #hash would make the browser scroll to it
	if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
	if (moved) window.scrollTo(0, 0);
	render();
}
for (const b of document.querySelectorAll("#tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab));
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
document.addEventListener("click", e => {
	const go = e.target.closest("[data-goto]");
	if (go) showTab(go.dataset.goto);
});

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function applyTheme(t) {
	if (t === "light") document.documentElement.dataset.theme = "light";
	else delete document.documentElement.dataset.theme;
	$("theme").innerHTML = t === "light" ? ICON.moon : ICON.sun;
	$("theme").title = t === "light" ? "Dark theme" : "Light theme";
}
$("theme").addEventListener("click", () => {
	const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
	try {
		localStorage.setItem("rtTheme", next);
	} catch (e) {}
	applyTheme(next);
});
applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");

// ---------------------------------------------------------------------------
// Top bar + banner
// ---------------------------------------------------------------------------
const memberName = () => String(st.rtMember || "").trim();
function initials(name) {
	const w = String(name || "").trim().split(/\s+/).filter(Boolean);
	return ((w[0] || "")[0] || "") + ((w.length > 1 ? w[w.length - 1] : "")[0] || "") || "RT";
}

// The status pill: green "Active" — automatic reply syncing is on (also between syncs) and
// outreach isn't stopped part-way; amber "Partly paused" — the reply sync is stopped, or an
// outreach run stopped with rows still waiting; grey "Paused" — only after Pause everything.
function statusOf() {
	const run = st.orRun || {};
	if (st.rtPaused) return { cls: "", text: "Paused", tip: "Pause everything is on — press “Start again”." };
	if (!configured()) return { cls: "", text: "Not set up", tip: "Connect your sheet in Settings." };
	const todo = (st.orItems || []).filter(isTodo).length;
	const why = [];
	if (st.syncStopped) why.push("The reply sync is stopped (Replies → Start sync).");
	if (!run.active && run.job === "send" && run.stopKind && todo > 0) why.push("Outreach stopped with rows still waiting (Outreach → Continue).");
	if (why.length) return { cls: "part", text: "Partly paused", tip: why.join(" ") };
	return { cls: "on", text: "Active", tip: run.active ? "Outreach is running, and replies sync automatically." : "Replies sync automatically every 20 minutes." };
}

function renderTop() {
	const paused = !!st.rtPaused;
	const s = statusOf();
	$("status").className = `status ${s.cls}`;
	$("status").title = s.tip;
	$("statusText").textContent = s.text;
	const p = $("pause");
	p.className = `btn sm ${paused ? "primary" : "secondary"}`;
	setHTML(p, paused ? `${ICON.play}<span>Start again</span>` : `${ICON.pause}<span>Pause everything</span>`);
	p.title = paused ? "Turn back on what was running" : "Stops outreach, reply sync and the accepted check";
	const who = memberName() || cfg.tabName;
	$("avatar").textContent = initials(who).toUpperCase();
	$("avatar").title = who || "";
	const n = (st.adList || []).length;
	$("tabCount").textContent = n;
	$("tabCount").classList.toggle("hidden", !n);
}

$("pause").addEventListener("click", async () => {
	$("pause").disabled = true;
	const r = await send({ type: st.rtPaused ? "RT_RESUME" : "RT_PAUSE" });
	$("pause").disabled = false;
	if (!r || !r.ok) alert((r && r.error) || "No answer from the extension.");
	else if (r.note) alert(r.note);
});

// Shown only when you need to act.
function renderBanner() {
	const run = st.orRun || {};
	const lines = [];
	if (!configured()) lines.push(["settings", "", "Not set up yet", "Connect your sheet in Settings.", "Open settings"]);
	if (st.rtLoggedOut) lines.push(["linkedin", "err", "LinkedIn logged out — sign in again", "Outreach, reply sync and sending wait until you're signed in.", "Sign in"]);
	const todo = (st.orItems || []).filter(isTodo).length;
	if (!run.active && run.stopKind === "cap" && todo && (run.stoppedAt || 0) >= startOfDay())
		lines.push(["outreach", "", "Daily invite limit reached — press Continue tomorrow", "Continue in Outreach sends more today if you really want to.", "Outreach"]);
	if (configured() && st.rtSheetError) lines.push(["settings", "err", "Can't reach your sheet — check settings", st.rtSheetError.error || "", "Settings"]);
	setHTML(
		$("banner"),
		lines.map(([go, cls, title, sub, action]) => `<a data-go="${go}" class="${cls}">${ICON.alert}<span><b>${esc(title)}</b><small>${esc(sub)}</small></span><span class="go label">${esc(action)} →</span></a>`).join("")
	);
	$("banner").classList.toggle("hidden", !lines.length);
}
$("banner").addEventListener("click", e => {
	const a = e.target.closest("[data-go]");
	if (!a) return;
	if (a.dataset.go === "linkedin") chrome.tabs.create({ url: "https://www.linkedin.com/login" });
	else showTab(a.dataset.go);
});

// ---------------------------------------------------------------------------
// Load + live updates
// ---------------------------------------------------------------------------
async function loadCounts() {
	const c = await send({ type: "OR_COUNTS" });
	if (c && c.ok !== false) counts = c;
	render();
}
async function loadAlarm() {
	const a = await chrome.alarms.get("replysync-reload").catch(() => null);
	nextSyncAt = a ? a.scheduledTime : 0;
}

document.addEventListener("DOMContentLoaded", async () => {
	showTab(location.hash.slice(1));
	cfg = await chrome.storage.sync.get(CFG_DEFAULTS);
	st = await chrome.storage.local.get(KEYS);
	for (const fn of changeHooks) fn(null);
	await loadAlarm();
	render();
	loadCounts();
	send({ type: "AD_REFRESH" }); // your sheet, at most once a minute
});

chrome.storage.onChanged.addListener((c, area) => {
	if (area === "sync") {
		for (const k of Object.keys(CFG_DEFAULTS)) if (c[k]) cfg[k] = c[k].newValue === undefined ? CFG_DEFAULTS[k] : c[k].newValue;
		return render();
	}
	if (area !== "local") return;
	for (const k of KEYS) if (c[k]) st[k] = c[k].newValue;
	for (const fn of changeHooks) fn(c);
	if (c.orCounts) loadCounts();
	else render();
});
setInterval(() => loadAlarm().then(render), 1000);
