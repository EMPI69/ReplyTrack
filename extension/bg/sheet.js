// The member's own Google Sheet, through their Apps Script web app (apps-script/Code.gs).
// Every request carries the secret key (in the body — never in the URL).
// Reads are answered straight away. Writes go through an outbox kept in storage: if the
// sheet can't be reached they're retried every minute, in order, until they go through.
// Only writes to the SHEET are ever retried — never anything on LinkedIn.
//
// storage.sync  { tabName, scriptUrl, secretKey, useGoogleLogin }  (the settings)
// storage.local rtOutbox [ { id, action, data, label, at, tries } ]
//               rtSheetError { at, error } — the "Can't reach your sheet" banner
const Sheet = (() => {
	const OUTBOX = "rtOutbox";
	const ERROR_KEY = "rtSheetError";
	const RETRY_ALARM = "rt-outbox";
	const POST_TIMEOUT_MS = 45000;
	// Answers about one row, not about the sheet: the write is dropped (and logged), not retried.
	const ROW_ERRORS = /^(profile not in tab|cell full|admin reply changed|several rows match|bad request|"[^"]+" (has a formula|is filled by a formula))/i;
	const afterHooks = [];

	async function settings() {
		const s = await chrome.storage.sync.get({ tabName: "", scriptUrl: "", secretKey: "", useGoogleLogin: false });
		return { tabName: String(s.tabName).trim(), scriptUrl: String(s.scriptUrl).trim(), secretKey: String(s.secretKey), useGoogleLogin: !!s.useGoogleLogin };
	}
	const configured = s => !!(s.tabName && s.scriptUrl && s.secretKey);

	// → the script's JSON answer, or { ok: false, error, transient } (transient = network trouble).
	async function post(body, s) {
		let lastError = "";
		for (let attempt = 1; attempt <= 2; attempt++) {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
			try {
				const res = await fetch(s.scriptUrl, {
					method: "POST",
					// text/plain keeps this a "simple" request; Apps Script still gets the JSON.
					headers: { "Content-Type": "text/plain;charset=utf-8" },
					body: JSON.stringify({ ...body, key: s.secretKey, tab: s.tabName }),
					redirect: "follow",
					credentials: s.useGoogleLogin ? "include" : "omit",
					signal: ctrl.signal,
				});
				const text = (await res.text()).trim();
				if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
				if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
				if (text.startsWith("<"))
					return {
						ok: false,
						error: 'Apps Script returned a web page instead of an answer. Check the deployment has "Who has access: Anyone", the URL ends in /exec, and the script was saved without errors.',
					};
				try {
					const j = JSON.parse(text);
					return j && typeof j === "object" ? j : { ok: false, error: `unexpected answer: ${text.slice(0, 120)}` };
				} catch (e) {
					// The old ReplyTrack script answers in plain text ("ok", "tab not found").
					return { ok: false, error: `unexpected answer "${text.slice(0, 80)}" — is the NEW Code.gs deployed?` };
				}
			} catch (e) {
				lastError = e.name === "AbortError" ? "timed out" : e.message || String(e);
				console.warn("[ReplySync] POST to Apps Script failed (attempt %d): %s", attempt, lastError);
				if (attempt < 2) await sleep(3000);
			} finally {
				clearTimeout(timer);
			}
		}
		return { ok: false, error: `could not reach Apps Script (${lastError})`, transient: true };
	}

	// One request with the saved settings. Notes the banner state.
	async function call(action, data = {}) {
		const s = await settings();
		if (!configured(s)) return { ok: false, error: "not set up", setup: true };
		const r = await post({ ...data, action }, s);
		if (r.ok || ROW_ERRORS.test(r.error || "")) await chrome.storage.local.remove(ERROR_KEY);
		else await chrome.storage.local.set({ [ERROR_KEY]: { at: Date.now(), error: r.error || "no answer" } });
		return r;
	}

	const read = () => call("read");

	// Settings test (from the settings page, maybe not saved yet).
	async function ping(override = {}) {
		const s = { ...(await settings()), ...override };
		if (!configured(s)) return { ok: false, error: "Enter the tab name, the web app URL and the secret key first." };
		return post({ action: "ping" }, s);
	}

	// ---------------------------------------------------------------------------
	// Outbox
	// ---------------------------------------------------------------------------
	let chain = Promise.resolve();
	const serial = fn => (chain = chain.then(fn, fn));

	// Saved first, then sent. Returns once it's saved (not when it's written).
	async function enqueue(action, data, label = "") {
		await serial(async () => {
			const box = await getLocal(OUTBOX, []);
			box.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, action, data, label, at: Date.now(), tries: 0 });
			await chrome.storage.local.set({ [OUTBOX]: box });
		});
		flush().catch(e => console.warn("[ReplySync] outbox:", e));
	}

	let flushing = null;
	const flush = () => flushing || (flushing = doFlush().finally(() => (flushing = null)));

	async function doFlush() {
		for (;;) {
			const box = await getLocal(OUTBOX, []);
			if (!box.length) {
				await chrome.alarms.clear(RETRY_ALARM);
				return;
			}
			const job = box[0];
			const r = await call(job.action, job.data);
			if (!r.ok && !ROW_ERRORS.test(r.error || "")) {
				// The sheet can't be reached, or the settings are wrong: keep it (in order) and try again.
				await serial(async () => {
					const b = await getLocal(OUTBOX, []);
					const it = b.find(x => x.id === job.id);
					if (it) it.tries = (it.tries || 0) + 1;
					await chrome.storage.local.set({ [OUTBOX]: b });
				});
				if (!job.tries) logFor(job.action)("warn", `Couldn't write to your sheet (${job.label || job.action}): ${r.error} — retrying every minute.`);
				chrome.alarms.create(RETRY_ALARM, { delayInMinutes: 1 });
				return;
			}
			report(job, r);
			await serial(async () => {
				const b = await getLocal(OUTBOX, []);
				await chrome.storage.local.set({ [OUTBOX]: b.filter(x => x.id !== job.id) });
			});
			for (const fn of afterHooks) Promise.resolve().then(() => fn(job, r)).catch(e => console.warn("[ReplySync] after write:", e));
		}
	}

	const logFor = action => (action === "markSent" || action === "markAccepted" ? orLog : rsLog);
	const WHAT = { markSent: "Outreach Status “Sent”", markAccepted: "“Accepted but not replied”", addReplies: "replies", clearAdmin: "Admin Reply and Response / Notes cleared" };

	function report(job, r) {
		const log = logFor(job.action);
		const what = WHAT[job.action] || job.action;
		const label = job.label ? `${job.label}: ` : "";
		if (!r.ok) return log("warn", `${label}not written to the sheet — ${r.error}.`);
		const skipped = (r.skipped || []).map(s => `row ${s.row}: ${s.why}`).join("; ");
		if (job.action === "clearAdmin") return log("info", `${label}row ${r.row} — ${what}${r.notes && r.notes !== "cleared" ? ` (Response / Notes ${r.notes})` : ""}.`);
		if ((r.written || []).length) log("info", `${label}${what} written in row ${r.written.join(", ")}${skipped ? ` · skipped ${skipped}` : ""}.`);
		else if (skipped) log("warn", `${label}nothing written — ${skipped}.`);
	}

	return { settings, configured, call, read, ping, enqueue, flush, RETRY_ALARM, afterWrite: fn => afterHooks.push(fn) };
})();
