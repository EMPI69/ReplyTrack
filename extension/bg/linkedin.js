// The worker tab (as in the outreach extension): one minimized window with an about:blank
// tab, our LinkedIn tab inside it. outreach.js is injected into that tab only and calls
// LinkedIn's Voyager API from there. Used by the outreach run, the accepted check and
// Admin Replies — one at a time (the lock). begin() … end(): end() closes the tab.
//
// storage.session  orWorkerWindowId, orWorkerTabId
// storage.local    orHeaders — LinkedIn's own x-li-* headers, seen on its requests
//                  orMe      — { pid } your own profile id
const LI = (() => {
	const WORK_URL = "https://www.linkedin.com/feed/";
	const SETTLE_S = [3, 5]; // s — after the worker tab loads, before the first call
	const WIN_KEY = "orWorkerWindowId";
	const TAB_KEY = "orWorkerTabId";
	const NO_RETRY = new Set(["OR_INVITE", "OR_MESSAGE"]); // a send is never retried (it may have gone through)
	let workerTabId = null;
	let liHeaders = {};
	let users = 0;

	class Fatal extends Error {
		constructor(kind, msg) {
			super(msg);
			this.kind = kind;
		}
	}
	const SIGNED_OUT = "LinkedIn signed you out. Sign in again in a normal tab, then press Continue.";
	const isLogin = url => /linkedin\.com\/(login|authwall|checkpoint|uas\/login|signup)/.test(url || "") || /^https:\/\/www\.linkedin\.com\/?(\?|$)/.test(url || "");

	// ---------------------------------------------------------------------------
	// Window + tab
	// ---------------------------------------------------------------------------
	let winP = null;
	async function workerWindow() {
		const { [WIN_KEY]: id } = await chrome.storage.session.get(WIN_KEY);
		if (id && (await chrome.windows.get(id).catch(() => null))) return id;
		if (!winP)
			winP = chrome.windows
				.create({ url: "about:blank", focused: false, state: "minimized" })
				.then(async w => {
					await chrome.storage.session.set({ [WIN_KEY]: w.id });
					return w.id;
				})
				.finally(() => (winP = null));
		return winP;
	}
	async function closeWorkerWindowIfIdle() {
		if (users > 0) return;
		const { [WIN_KEY]: id } = await chrome.storage.session.get(WIN_KEY);
		if (!id) return;
		await chrome.storage.session.remove(WIN_KEY);
		await chrome.windows.remove(id).catch(() => {});
	}

	async function ping(tabId) {
		try {
			const r = await chrome.tabs.sendMessage(tabId, { type: "OR_PING" });
			return r && r.ok ? r : null;
		} catch (e) {
			return null;
		}
	}
	async function ensureClient(tabId) {
		if (await ping(tabId)) return true;
		try {
			await chrome.scripting.executeScript({ target: { tabId }, files: ["outreach.js"] }); // isolated world
		} catch (e) {
			return false;
		}
		return !!(await ping(tabId));
	}
	async function waitLoad(tabId, timeout = 30000) {
		const end = Date.now() + timeout;
		while (Date.now() < end) {
			const t = await chrome.tabs.get(tabId).catch(() => null);
			if (!t) return null;
			if (t.status === "complete") return t;
			await sleep(400);
		}
		return chrome.tabs.get(tabId).catch(() => null);
	}

	let tabP = null;
	const workTab = () => tabP || (tabP = findTab().finally(() => (tabP = null)));
	async function findTab() {
		if (workerTabId && (await ping(workerTabId))) return workerTabId;
		if (workerTabId) {
			// e.g. it was on a conversation for an Admin Reply check: just load the client again.
			const t = await chrome.tabs.get(workerTabId).catch(() => null);
			if (t && /^https:\/\/www\.linkedin\.com\//.test(t.url || "") && !isLogin(t.url) && (await ensureClient(workerTabId))) return workerTabId;
			await chrome.tabs.remove(workerTabId).catch(() => {});
		}
		workerTabId = null;
		orLog("info", "Opening a LinkedIn tab in a minimized window to work from.");
		let windowId;
		try {
			windowId = await workerWindow();
		} catch (e) {}
		const tab = await chrome.tabs.create({ ...(windowId ? { windowId } : {}), url: WORK_URL, active: false });
		workerTabId = tab.id;
		await chrome.storage.session.set({ [TAB_KEY]: tab.id });
		listenHeaders(tab.id);
		for (let i = 0; i < 3; i++) {
			if (i) await chrome.tabs.reload(tab.id).catch(() => {});
			await sleep(300);
			const t = await waitLoad(tab.id);
			if (t && isLogin(t.url)) throw new Fatal("signedOut", SIGNED_OUT);
			if (await ensureClient(tab.id)) {
				const p = await ping(tab.id);
				if (p && !p.signedIn) throw new Fatal("signedOut", SIGNED_OUT);
				await sleep(rand(...SETTLE_S) * 1000); // let the page settle (and its own requests show LinkedIn's headers)
				return tab.id;
			}
		}
		throw new Error("Couldn't prepare a LinkedIn tab to work from.");
	}

	// Lookups may be retried once. A send is never retried here (it may have gone through).
	async function call(msg) {
		const retry = !NO_RETRY.has(msg.type);
		for (let attempt = 0; ; attempt++) {
			const tabId = await workTab();
			try {
				const r = await chrome.tabs.sendMessage(tabId, { ...msg, headers: { ...liHeaders } });
				if (r && r.fatal) throw new Fatal(r.kind, r.kind === "signedOut" ? SIGNED_OUT : r.error);
				return r || { ok: false, error: "no answer from the LinkedIn tab" };
			} catch (e) {
				if (e instanceof Fatal) throw e;
				workerTabId = null;
				if (!retry) return { ok: false, code: "uncertain", error: `the LinkedIn tab went away mid-request (${e.message})` };
				if (attempt) throw e;
				await sleep(2000);
			}
		}
	}

	// Your own profile id (asked once, then remembered).
	async function me() {
		const m = await getLocal("orMe", null);
		if (m && m.pid) return m.pid;
		const r = await call({ type: "OR_ME" });
		if (!r.ok) return "";
		await chrome.storage.local.set({ orMe: { pid: r.pid } });
		return r.pid;
	}

	// Opens one conversation in the worker tab and lets content.js read it (read only).
	// → { ok, threadId, profileHref, name, otherHrefs, mine: [text], theirs } | { ok: false, error }
	async function readThread(threadId) {
		const tabId = await workTab();
		const id = String(threadId);
		const url = `https://www.linkedin.com/messaging/thread/${/^[\w\-=%.]+$/.test(id) ? id : encodeURIComponent(id)}/`;
		await chrome.tabs.update(tabId, { url });
		await sleep(500);
		const t = await waitLoad(tabId, 45000);
		if (t && isLogin(t.url)) throw new Fatal("signedOut", SIGNED_OUT);
		let ready = null;
		for (let i = 0; i < 40 && !ready; i++) {
			ready = await chrome.tabs.sendMessage(tabId, { type: "RT_PING" }).catch(() => null);
			if (!ready) await sleep(500);
		}
		if (!ready) return { ok: false, error: "the conversation page did not load" };
		if (ready.login) throw new Fatal("signedOut", SIGNED_OUT);
		const r = await chrome.tabs.sendMessage(tabId, { type: "RT_READ_THREAD" }).catch(e => ({ ok: false, error: e.message }));
		if (r && r.loggedOut) throw new Fatal("signedOut", SIGNED_OUT);
		return r || { ok: false, error: "no answer from the conversation page" };
	}

	// ---------------------------------------------------------------------------
	// LinkedIn's own headers (x-li-track, x-li-lang, x-li-page-instance), read from the
	// worker tab's own requests with chrome.webRequest — outside the page, invisible to it.
	// ---------------------------------------------------------------------------
	const HDR_KEEP = /^(x-li-track|x-li-lang|x-li-page-instance)$/i;
	function onWorkerHeaders(d) {
		let changed = false;
		for (const h of d.requestHeaders || []) {
			const k = h.name.toLowerCase();
			if (HDR_KEEP.test(k) && h.value && h.value !== "undefined" && liHeaders[k] !== h.value) {
				liHeaders[k] = h.value;
				changed = true;
			}
		}
		if (changed) chrome.storage.local.set({ orHeaders: liHeaders }).catch(() => {});
	}
	function stopHeaders() {
		if (chrome.webRequest.onSendHeaders.hasListener(onWorkerHeaders)) chrome.webRequest.onSendHeaders.removeListener(onWorkerHeaders);
	}
	function listenHeaders(tabId) {
		stopHeaders();
		chrome.webRequest.onSendHeaders.addListener(onWorkerHeaders, { urls: ["https://www.linkedin.com/voyager/api/*"], tabId, types: ["xmlhttprequest"] }, ["requestHeaders"]);
	}

	// A request body seen by chrome.webRequest, as text (for learning LinkedIn's requests).
	function rawBody(rb) {
		try {
			if (!rb || !rb.raw) return "";
			const parts = rb.raw.filter(p => p.bytes).map(p => new Uint8Array(p.bytes));
			const len = parts.reduce((a, p) => a + p.length, 0);
			if (!len || len > 200000) return "";
			const all = new Uint8Array(len);
			let o = 0;
			for (const p of parts) {
				all.set(p, o);
				o += p.length;
			}
			return new TextDecoder().decode(all);
		} catch (e) {
			return "";
		}
	}

	// ---------------------------------------------------------------------------
	// Users
	// ---------------------------------------------------------------------------
	async function begin() {
		users++;
		liHeaders = (await getLocal("orHeaders", {})) || {};
	}
	async function end() {
		users = Math.max(0, users - 1);
		if (users) return;
		stopHeaders();
		if (workerTabId) await chrome.tabs.remove(workerTabId).catch(() => {});
		workerTabId = null;
		await chrome.storage.session.remove(TAB_KEY);
		closeWorkerWindowIfIdle().catch(() => {});
	}
	// The service worker restarted mid-run: carry on with the same tab.
	async function adopt() {
		const { [TAB_KEY]: id } = await chrome.storage.session.get(TAB_KEY);
		if (id) {
			workerTabId = id;
			listenHeaders(id);
		}
	}
	const isWorker = tabId => tabId != null && tabId === workerTabId;

	return { Fatal, SIGNED_OUT, isLogin, call, me, readThread, begin, end, adopt, isWorker, rawBody, closeWorkerWindowIfIdle };
})();
