// Outreach: the queue (the outreach extension's background.js, reading your sheet instead
// of a CSV). Delays, limits, checks, retries, automatic stops and Dry run are unchanged.
//
// storage.local
//   orSheet     { tab, header, first, rows, loadedAt, statusValues, stats } — the rows, read at
//               every Start and with "Reload rows from sheet"
//   orItems     [ { id, key, url, rows:[sheet row numbers], noteRow, status, … } ] — one per
//               person, in sheet order. status: pending | sent | skipped | failed
//   orSettings  see shared.js DEFAULTS
//   orRun       { active, job, target, processed, sent, … }          — the running / last run
//   orCounts    { day, n, extra }                                    — today's requests, for the auto-stop
//   h:<key>     ts                                                   — a request was sent to this person (kept forever)
//   orTplInvite connection request learned from a manual send
//   orLog       log lines (last 400, at most 7 days old)
//
// Which rows: Outreach Status empty or "Not Started", and both LinkedIn Profile and
// Personalized Message filled. A person with another row that has any other status is
// never touched. After a request is sent the sheet gets Outreach Status "Sent" and the
// Sent Date (through Sheet's outbox). No request is sent, but the row still gets "Sent":
//   - a request this extension sent before (its history, imported history included):
//     Sent Date = the date it was sent then (left empty if the history has no date);
//   - a request already pending on LinkedIn: Sent Date left empty.
// Already a 1st-degree connection: no request is possible, so the person goes to the popup's
// "To send" list, where you can send the Personalized Message as a chat (bg/admin.js).
// Other skipped rows and failed rows: nothing is written — the reason shows here only.
//
// Jobs (one at a time, one profile at a time — never parallel):
//   send  — waiting rows in sheet order: look the profile up; not connected → wait a few
//           seconds → connection request with the note; connected / pending → skip.
//           The first 3 requests of a run, and about 1 in 20 after, are checked on
//           LinkedIn after sending (the profile must now show the request as pending).
//   check — dry run: look waiting rows up, send nothing, write nothing, say what would happen.
const Outreach = (() => {
	const log = orLog;
	const RUN_KEY = "orRun";
	const MAX_ATTEMPTS = 3;
	const MAX_CONSECUTIVE_ERRORS = 5;
	const NOVISIT_PAUSE = [0.3, 0.8]; // s — row skipped without visiting the profile
	const VERIFY_FIRST = 3; // check the first N requests of every run on LinkedIn…
	const VERIFY_SHARE = 0.05; // …and about 1 in 20 after that
	const keyOf = id => String(id || "").toLowerCase();
	const rowNo = it => it.rows[0]; // the spreadsheet row
	const { Fatal } = LI;

	let running = false;
	let stopFlag = false;

	// ---------------------------------------------------------------------------
	// Storage helpers (writes serialized)
	// ---------------------------------------------------------------------------
	const get = async k => (await chrome.storage.local.get(k))[k];
	let chain = Promise.resolve();
	const serial = fn => (chain = chain.then(fn, fn));

	const getRun = async () => (await get(RUN_KEY)) || { active: false };
	const patchRun = p =>
		serial(async () => {
			const s = { ...(await getRun()), ...p };
			await chrome.storage.local.set({ [RUN_KEY]: s });
			return s;
		});
	const settings = async () => ({ ...S.DEFAULTS, ...((await get("orSettings")) || {}) });

	function patchItem(key, patch) {
		return serial(async () => {
			const items = (await get("orItems")) || [];
			const it = items.find(x => x.key === key);
			if (!it) return null;
			for (const [k, v] of Object.entries(patch)) if (v === undefined) delete it[k];
				else it[k] = v; // undefined = drop the field (nothing kept that isn't needed)
			await chrome.storage.local.set({ orItems: items });
			return it;
		});
	}

	// ---------------------------------------------------------------------------
	// Today's count + the daily auto-stop. Continue past it = another dailyCap today.
	// ---------------------------------------------------------------------------
	// orCounts only ever holds today: { day, n, extra } — a new day starts from 0.
	async function todayCounts() {
		const c = (await get("orCounts")) || {};
		const day = startOfDay();
		return c.day === day ? { day, n: c.n || 0, extra: c.extra || 0 } : { day, n: 0, extra: 0 };
	}
	async function capState(st) {
		const c = await todayCounts();
		const limit = st.dailyCap > 0 ? st.dailyCap + c.extra : 0;
		return { today: c.n, limit, reached: !!limit && c.n >= limit };
	}
	const bumpSent = () =>
		serial(async () => {
			const c = await todayCounts();
			c.n++;
			await chrome.storage.local.set({ orCounts: c });
		});
	// The limit becomes: requests sent so far today + dailyCap.
	const grantMore = () =>
		serial(async () => {
			const c = await todayCounts();
			c.extra = c.n;
			await chrome.storage.local.set({ orCounts: c });
		});

	// Everyone this extension sent a request to: one small key per profile
	// ("h:<vanity or id>" → time), so nothing large is rewritten per send. Never forgotten.
	const H = k => "h:" + keyOf(k);
	const remember = keys => chrome.storage.local.set(Object.fromEntries([...new Set(keys.filter(Boolean).map(H))].map(k => [k, Date.now()])));
	async function sentBefore(keys) {
		const ks = keys.filter(Boolean).map(H);
		if (!ks.length) return 0;
		const h = await chrome.storage.local.get(ks);
		return Math.max(0, ...ks.map(k => h[k] || 0));
	}

	// A history time before 2003 means "sent, date unknown" (an import without a date).
	const UNKNOWN_DATE = 1;
	const knownDate = t => t > 1041379200000;

	// "Import sent history": { key or profile URL → time } from the old outreach extension.
	async function importHistory(entries) {
		const add = {};
		for (const [k, v] of Object.entries(entries || {})) {
			const key = keyOf(String(k).replace(/^h:/, "").includes("linkedin.com") ? S.idFromCell(String(k).replace(/^h:/, "")) : String(k).replace(/^h:/, ""));
			if (key) add[H(key)] = Number(v) > 0 ? Number(v) : UNKNOWN_DATE;
		}
		const keys = Object.keys(add);
		if (!keys.length) return { ok: false, error: "No people found in that file." };
		const have = await chrome.storage.local.get(keys);
		let added = 0;
		for (const k of keys) {
			// The earliest known date wins; an unknown date never replaces a known one.
			if (have[k]) add[k] = knownDate(have[k]) && knownDate(add[k]) ? Math.min(have[k], add[k]) : knownDate(have[k]) ? have[k] : add[k];
			else added++;
		}
		await chrome.storage.local.set(add);
		log("info", `Imported sent history: ${plural(keys.length, "person", "people")} (${added} new). They never get another request from this extension.`);
		return { ok: true, n: keys.length, added };
	}

	// ---------------------------------------------------------------------------
	// Self-repair: when YOU send a connection request with a note by hand (any LinkedIn tab
	// except the worker tab), the page's own request is saved as a template and tried first.
	// Observed with chrome.webRequest — nothing is injected into your pages.
	// ---------------------------------------------------------------------------
	const LEARN_URLS = [
		"https://www.linkedin.com/voyager/api/voyagerRelationshipsDashMemberRelationships*",
		"https://www.linkedin.com/voyager/api/*nvitation*",
		"https://www.linkedin.com/flagship-web/rsc-action/*",
	];
	const INVITE_URL = /verifyQuotaAndCreate|normInvitations|voyagerRelationshipsDashInvitation|Invit(e|ation)(Action|Create)|ConnectAction|SendInvit/i;
	const INVITE_BODY = /"inviteeUnion"|"invitee"\s*:|"inviteeProfileUrn"|"inviteeUrn"|InviteAction|InvitationAction|ConnectAction|SendInvit/i;
	const NOT_INVITE = /withdraw|ignore|accept|decline|reject|remove|delete/i;
	const NOTE_KEY = /^(customMessage|message|note|invitationMessage|inviteMessage)$/i;
	const PER_REQUEST = /^(csrf-token|x-li-traceparent|x-li-tracestate|x-li-pageforestid|x-li-page-instance-tracking-id|content-length|cookie|origin|referer|user-agent|sec-.*|accept-encoding|accept-language|connection|host)$/i;
	const COPY_HEADER = /^(accept|content-type|x-li-[\w-]+|x-restli-protocol-version|x-sdui-[\w-]+|rsc|next-[\w-]+)$/i;
	const caught = new Map();

	chrome.webRequest.onBeforeRequest.addListener(
		d => {
			if (d.method !== "POST" || d.tabId < 0 || LI.isWorker(d.tabId)) return;
			let path;
			try {
				const u = new URL(d.url);
				path = u.pathname + u.search;
			} catch (e) {
				return;
			}
			const body = LI.rawBody(d.requestBody);
			if (NOT_INVITE.test(path) || !(INVITE_URL.test(path) || INVITE_BODY.test(body))) return;
			caught.set(d.requestId, { url: path, body, tabId: d.tabId });
			if (caught.size > 20) caught.delete(caught.keys().next().value);
		},
		{ urls: LEARN_URLS, types: ["xmlhttprequest"] },
		["requestBody"]
	);
	chrome.webRequest.onSendHeaders.addListener(
		d => {
			const c = caught.get(d.requestId);
			if (c) c.headers = d.requestHeaders || [];
		},
		{ urls: LEARN_URLS, types: ["xmlhttprequest"] },
		["requestHeaders"]
	);
	chrome.webRequest.onCompleted.addListener(
		d => {
			const c = caught.get(d.requestId);
			if (!c) return;
			caught.delete(d.requestId);
			if (d.statusCode >= 200 && d.statusCode < 300) learnInvite(c).catch(e => console.warn("[Outreach] learn failed", e));
		},
		{ urls: LEARN_URLS, types: ["xmlhttprequest"] }
	);
	chrome.webRequest.onErrorOccurred.addListener(d => caught.delete(d.requestId), { urls: LEARN_URLS });

	const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	async function learnInvite(c) {
		if (LI.isWorker(c.tabId)) return; // our own request
		let j;
		try {
			j = JSON.parse(c.body);
		} catch (e) {
			return;
		}
		const me = await get("orMe");
		const tab = await chrome.tabs.get(c.tabId).catch(() => null);
		const vm = String((tab && tab.url) || "").match(/linkedin\.com\/in\/([^/?#]+)/);
		let vanity = "";
		try {
			vanity = vm ? decodeURIComponent(vm[1]) : "";
		} catch (e) {}
		let url = c.url;
		let decoded = url;
		try {
			decoded = decodeURIComponent(url);
		} catch (e) {}
		// The note you typed → {{NOTE}}; one-off tokens → fresh per send.
		let noteSlot = false;
		(function walk(o) {
			if (!o || typeof o !== "object") return;
			for (const [k, v] of Object.entries(o)) {
				if (typeof v === "string") {
					if (NOTE_KEY.test(k) && v.trim() && !/^urn:|\{\{/.test(v)) {
						o[k] = "{{NOTE}}";
						noteSlot = true;
					} else if (/^(originToken|clientGeneratedToken|dedupeToken)$/.test(k)) o[k] = "{{UUID}}";
					else if (k === "trackingId") o[k] = "{{TRACKING}}";
				} else if (v && typeof v === "object") walk(v);
			}
		})(j);
		if (!noteSlot) {
			log("info", "Saw a connection request you sent by hand without a note — not learned. Send one WITH a note to teach the extension LinkedIn's current request.");
			return;
		}
		let body = JSON.stringify(j);
		const ids = [...new Set([...(decoded + " " + body).matchAll(/fsd_profile:(ACoA[\w-]{10,})/g)].map(m => m[1]))].filter(x => !(me && me.pid === x));
		if (ids.length === 1) {
			const re = new RegExp(esc(ids[0]), "g");
			url = url.replace(re, "{{PROFILE_ID}}");
			body = body.replace(re, "{{PROFILE_ID}}");
		} else if (ids.length > 1) return; // can't tell whose id is whose
		if (vanity.length > 2) body = body.replace(new RegExp(`"${esc(vanity)}"`, "g"), '"{{VANITY}}"');
		if (!/\{\{(PROFILE_ID|VANITY)\}\}/.test(url + body)) return;
		const headers = {};
		for (const h of c.headers || []) {
			const k = h.name.toLowerCase();
			if (COPY_HEADER.test(k) && !PER_REQUEST.test(k) && h.value) headers[k] = h.value;
		}
		await chrome.storage.local.set({ orTplInvite: { method: "POST", url, body, headers, learnedAt: Date.now(), fail: 0 } });
		log("info", `Learned LinkedIn's own connection request from your manual send (${url.split("?")[0]}) — it's tried first from now on.`);
	}

	async function learnedTemplate() {
		const t = await get("orTplInvite");
		return t && (t.fail || 0) < 3 ? t : null;
	}
	async function scoreTemplate(result) {
		if (!result) return;
		const t = await get("orTplInvite");
		if (!t) return;
		t.fail = result === "ok" ? 0 : (t.fail || 0) + 1;
		await chrome.storage.local.set({ orTplInvite: t });
		if (t.fail === 3) log("warn", "The learned connection request failed 3 times — using the built-in one. Send one request with a note by hand to learn the current one.");
	}

	// ---------------------------------------------------------------------------
	// The sheet: rows → one item per person
	// ---------------------------------------------------------------------------
	// Everything a note may use from the row — when it changes, a row skipped because of
	// its note waits again.
	const noteHashOf = (st, row) => hash(JSON.stringify([st.noteMode, st.noteMode === "typed" ? st.noteText : "", row]));

	async function loadSheet() {
		if (running) return { ok: false, error: "Stop the run first." };
		const r = await Sheet.read();
		if (!r.ok) return { ok: false, error: r.setup ? "Enter your sheet settings first (⚙️ in the popup)." : `Couldn't read your sheet: ${r.error}` };
		const header = r.header || [];
		const c = {};
		for (const k of ["profile", "message", "status", "name"]) c[k] = S.findCol(header, S.COLUMNS[k]);
		for (const k of ["profile", "message", "status"]) if (c[k] < 0) return { ok: false, error: `Your sheet has no “${S.COLUMNS[k]}” column.` };

		const stats = { rows: 0, waiting: 0, statuses: {}, noUrl: 0, noMessage: 0, blocked: 0 };
		const groups = new Map(); // person → { id, url, rows: [{ row, status, msg }] }
		r.rows.forEach((cells, i) => {
			if (!cells.some(x => String(x).trim())) return; // empty row
			stats.rows++;
			const status = String(cells[c.status] || "").trim();
			if (status) stats.statuses[status] = (stats.statuses[status] || 0) + 1;
			const url = String(cells[c.profile] || "").trim();
			const id = S.idFromCell(url);
			if (!id) {
				if (S.isSendable(status)) stats.noUrl++;
				return;
			}
			const key = keyOf(id);
			const g = groups.get(key) || { id, url, name: c.name >= 0 ? String(cells[c.name] || "").trim() : "", rows: [] };
			g.rows.push({ row: r.first + i, status, msg: String(cells[c.message] || "").trim() });
			groups.set(key, g);
		});

		const st = await settings();
		const old = new Map(((await get("orItems")) || []).map(it => [it.key, it]));
		const items = [];
		for (const [key, g] of groups) {
			const open = g.rows.filter(x => S.isSendable(x.status));
			const withMsg = open.filter(x => x.msg);
			const o = old.get(key);
			// Every row of this person must still be open, and one must have a message.
			if (!open.length || open.length < g.rows.length || !withMsg.length) {
				if (open.length && open.length < g.rows.length) stats.blocked++;
				else if (open.length) stats.noMessage += open.length;
				// Results of earlier runs stay for the table and the export.
				if (o && o.status !== "pending") items.push({ ...o, url: g.url, rows: g.rows.map(x => x.row), done: true });
				continue;
			}
			const noteRow = withMsg[0].row;
			const it = o ? { ...o } : { id: g.id, key, status: "pending" };
			Object.assign(it, { id: g.id, url: g.url, rows: open.map(x => x.row), noteRow, name: it.name || g.name || "" });
			delete it.done;
			// A row skipped because of its note waits again once its message (or the typed note) changes.
			if (it.status === "skipped" && it.noteSkip && it.noteHash !== noteHashOf(st, r.rows[noteRow - r.first])) {
				for (const k of ["noteSkip", "noteHash", "detail", "would"]) delete it[k];
				it.status = "pending";
			}
			items.push(it);
		}
		items.sort((a, b) => a.rows[0] - b.rows[0]);
		stats.waiting = items.filter(x => !x.done && isTodo(x)).length;
		const sheet = { tab: r.tab, header, first: r.first, rows: r.rows, loadedAt: Date.now(), statusValues: r.statusValues || [], stats };
		await chrome.storage.local.set({ orSheet: sheet, orItems: items });
		log("info", `Rows loaded from “${r.tab}”: ${plural(stats.rows, "row")}, ${plural(stats.waiting, "person", "people")} waiting for a request.`);
		return { ok: true, stats, waiting: stats.waiting };
	}

	// Outreach Status "Sent" + Sent Date (at; null = left empty), in every open row of that person.
	const markSent = (it, at) => Sheet.enqueue("markSent", { profileUrl: it.url, sentAt: at || null }, `row ${rowNo(it)} (${it.name || it.id})`);

	// ---------------------------------------------------------------------------
	// One row
	// ---------------------------------------------------------------------------
	const nameOf = p => [p.firstName, p.lastName].filter(Boolean).join(" ");
	const DEG = { 1: "1st", 2: "2nd", 3: "3rd", 4: "out of network" };
	const day = t => new Date(t).toLocaleDateString();
	const skip = (patch, summary, extra = {}) => ({ patch: { ...patch, status: "skipped" }, summary: `skipped — ${summary}`, ...extra });

	// No request now, but the sheet gets "Sent" (mark.sentAt = the Sent Date, null = left empty).
	const marked = (job, date) => (job === "check" ? ` — a run marks it “Sent” in the sheet${date ? "" : " (no Sent Date)"}` : ` — marked “Sent” in the sheet${date ? "" : " (no Sent Date)"}`);
	// Sent before by this extension (or in the imported history): never again.
	function alreadySent(t, job, base = {}, extra = {}) {
		const when = knownDate(t) ? day(t) : "an unknown date";
		const date = knownDate(t) ? t : null;
		return skip({ ...base, detail: `request already sent by this extension on ${when}${marked(job, date)}` }, `request already sent by this extension (${when})${marked(job, date)}`, { ...extra, mark: { sentAt: date } });
	}
	// A request is already pending on LinkedIn (sent some other way).
	const alreadyPending = (job, base) => skip({ ...base, detail: `request already pending${marked(job, null)}` }, `request already pending${marked(job, null)}`, { mark: { sentAt: null } });
	// Already a connection: no request possible. Listed in "To send", to send the message as a chat.
	async function alreadyConnected(job, base, it, p) {
		if (job !== "check") await Admin.noteConnected(it.url, p);
		const where = job === "check" ? " — a run lists it in To send (send your message as a chat)" : " — listed in To send: send your message as a chat";
		return skip({ ...base, detail: `already a connection${where}` }, `already a connection${where}`, { connected: true });
	}

	// → { patch, summary, sent?, noVisit?, level?, defer?, stop?, mark? }
	async function processOne(it, job, st, sheet, ctx) {
		const row = sheet.rows[it.noteRow - sheet.first] || [];
		const header = sheet.header;
		const noteSkipped = reason => ({ detail: reason, noteSkip: true, noteHash: noteHashOf(st, row) });

		// Checks that need no profile visit
		const before = await sentBefore([it.key]);
		if (before) return alreadySent(before, job, {}, { noVisit: true });
		const pre = S.buildNote(st, header, row, null);
		if (pre.skip) return skip(noteSkipped(pre.skip), pre.skip, { noVisit: true, level: "warn" });

		// Profile + connection status
		const p = await LI.call({ type: "OR_PROFILE", identity: it.id });
		const trail = p.log && p.log.length ? ` [${p.log.join("; ")}]` : "";
		if (!p.ok) {
			if (p.unavailable) return skip({ detail: p.error, checkedAt: Date.now() }, p.error, { level: "warn" });
			throw new Error((p.error || "profile lookup failed") + trail);
		}
		const rel = p.rel || { known: false };
		const base = { name: nameOf(p) || it.name || "", pid: p.pid, publicId: p.publicId, degree: rel.degree || null, checkedAt: Date.now() };
		const after = await sentBefore([p.publicId]);
		if (after) return alreadySent(after, job, base);
		if (rel.self) return skip({ ...base, detail: "this is your own profile" }, "your own profile");
		if (rel.degree === 1) return alreadyConnected(job, base, it, p);
		if (rel.pending) {
			if (rel.incoming) return skip({ ...base, detail: "they already sent you a request — accept it on LinkedIn" }, "they already sent you a request");
			if (it.uncertainAt) return { patch: { ...base, status: "sent", sentAt: it.uncertainAt, detail: "request found pending after an unclear answer — counted as sent" }, summary: "request is pending (it went through earlier) — counted as sent" };
			return alreadyPending(job, base);
		}
		const note = S.buildNote(st, header, row, p);
		const unknown = rel.known ? "" : " (connection status not readable — LinkedIn's answer decides)";

		if (job === "check") {
			const would = note.skip ? `skip — ${note.skip}` : `${note.text ? `send the request with the note (${S.chars(note.text)} chars)` : "send the request without a note"}${unknown}`;
			return { patch: { ...base, would }, summary: `${DEG[base.degree] || "degree ?"} → would ${would}${rel.known ? "" : trail}` };
		}
		if (note.skip) return skip({ ...base, ...noteSkipped(note.skip) }, note.skip, { level: "warn" });

		const cap = await capState(st);
		if (cap.reached) return { defer: true, patch: base, stop: { kind: "cap", reason: `Auto-stopped at today's limit (${cap.today} requests sent today).` } };

		// Stay on the profile for a few seconds, like reading it, before sending.
		const readMs = rand(st.readMin, st.readMax) * 1000;
		await publishNext(readMs, "reading");
		if (!(await pause(readMs))) return { defer: true, patch: base };

		const r = await LI.call({ type: "OR_INVITE", pid: base.pid, vanity: base.publicId || it.id, note: note.text, learned: await learnedTemplate() });
		await scoreTemplate(r.learnedResult);
		const rtrail = r.log && r.log.length ? ` [${r.log.join("; ")}]` : "";
		if (r.ok) {
			await bumpSent();
			const how = note.text ? "with note" : "without a note";
			const sent = { ...base, status: "sent", noteSent: note.text, sentAt: Date.now(), detail: `request sent ${how}` };
			const summary = note.text ? `request sent with note (${S.chars(note.text)} chars)` : "request sent without a note";
			// Check it on LinkedIn: the first 3 of every run, ~1 in 20 after.
			if (!(ctx.sends < VERIFY_FIRST || Math.random() < VERIFY_SHARE)) {
				await remember([it.key, base.publicId]);
				return { patch: sent, sent: true, summary };
			}
			const v = await checkSent(it, base, note.text);
			const vtrail = v.log && v.log.length ? ` [${v.log.join("; ")}]` : "";
			if (v.ok && v.known && !v.pending && !v.connected) {
				// LinkedIn said OK, but the request isn't there. Not added to the history, so
				// Continue re-checks this row first (pending by then → counted as sent).
				return {
					patch: { ...base, status: "failed", attempts: (it.attempts || 0) + 1, uncertainAt: sent.sentAt, noteSent: note.text, detail: "LinkedIn answered OK, but the profile doesn't show the request as pending" },
					summary: `LinkedIn answered OK, but the profile doesn't show the request as pending${vtrail}`,
					level: "error",
					sent: true,
					check: { outcome: "fail" },
					stopAfter: { kind: "verify", reason: `LinkedIn answered OK for row ${rowNo(it)} (${base.name || it.id}), but the profile doesn't show the request as pending — stopped to be safe. Look that person up on LinkedIn; Continue re-checks that row first.` },
				};
			}
			await remember([it.key, base.publicId]);
			if (!v.ok || !v.known)
				return { patch: { ...sent, detail: `request sent ${how} (the check on LinkedIn couldn't read the status)` }, sent: true, summary: `${summary} · check couldn't read the status${vtrail}`, level: "warn", check: { outcome: "unknown", error: v.error || "connection status not readable" } };
			const seen = v.noteSeen ? `, note found in ${v.where}` : "";
			return {
				patch: { ...sent, verified: v.noteSeen ? "note" : "pending", detail: `request sent ${how} — checked on LinkedIn: pending${seen}` },
				sent: true,
				summary: `${summary} · ✓ checked on LinkedIn: pending${seen}`,
				check: { outcome: v.noteSeen ? "pass" : "passNoNote", where: v.where, inSentList: !!v.inSentList },
			};
		}
		switch (r.code) {
			case "pending":
				if (it.uncertainAt) return { patch: { ...base, status: "sent", sentAt: it.uncertainAt, detail: "request found pending after an unclear answer — counted as sent" }, summary: "request is pending (it went through earlier) — counted as sent" };
				return alreadyPending(job, base);
			case "connected":
				return alreadyConnected(job, base, it, p);
			case "cantResend":
				return skip({ ...base, detail: "LinkedIn won't take a new request to this person yet (a recent one was withdrawn)" }, "LinkedIn won't take a new request yet (recently withdrawn)", { level: "warn" });
			case "emailRequired":
				return skip({ ...base, detail: "LinkedIn asks for their email address to connect" }, "LinkedIn asks for their email address", { level: "warn" });
			case "noteRefused":
				return { defer: true, patch: base, stop: { kind: "noteRefused", reason: `LinkedIn refused the note (${r.error}). Check that this account has Premium, then Continue.` } };
			case "limit":
				return { defer: true, patch: base, stop: { kind: "limit", reason: `LinkedIn says this account has reached its invitation limit for now (${r.error}).` } };
			case "uncertain":
				// May have gone through: counted, and re-checked on the next Continue (a pending request then counts as sent).
				// Not added to the history on purpose: the re-check must visit the profile.
				await bumpSent();
				return { patch: { ...base, status: "failed", attempts: (it.attempts || 0) + 1, uncertainAt: Date.now(), detail: `unclear answer (${r.error}) — re-checked on Continue` }, summary: `unclear answer from LinkedIn — will be re-checked${rtrail}`, level: "warn", sent: true, error: true };
			default:
				throw new Error(`connection request failed: ${r.error}${rtrail}`);
		}
	}

	// After sending: read the profile again (a second time after 5 s if the request
	// doesn't show yet — LinkedIn can take a moment).
	async function checkSent(it, base, note) {
		await sleep(rand(2, 4) * 1000);
		const ask = () => LI.call({ type: "OR_VERIFY", identity: base.publicId || it.id, pid: base.pid, vanity: base.publicId, note });
		let v = await ask();
		if (v.ok && v.known && !v.pending && !v.connected) {
			await sleep(5000);
			v = await ask();
		}
		return v;
	}

	// ---------------------------------------------------------------------------
	// Run loop
	// ---------------------------------------------------------------------------
	const retryable = it => it.status === "failed" && (it.attempts || 0) < MAX_ATTEMPTS;
	const isTodo = it => !it.done && (it.status === "pending" || retryable(it));
	// Order: rows whose request may have gone through (re-checked first), then waiting
	// rows in sheet order, then other failed rows.
	const nextItem = (items, attempted) =>
		items.find(x => !x.done && retryable(x) && x.uncertainAt && !attempted.has(x.key)) ||
		items.find(x => !x.done && x.status === "pending" && !attempted.has(x.key)) ||
		items.find(x => !x.done && retryable(x) && !attempted.has(x.key));

	let publishNext = async () => {};
	async function pause(ms) {
		const until = Date.now() + ms;
		while (!stopFlag && Date.now() < until) await sleep(Math.min(300, until - Date.now()));
		return !stopFlag;
	}
	const nextBreak = st => (st.breakEvery > 0 ? Math.max(1, Math.round(st.breakEvery * rand(0.8, 1.2))) : Infinity);

	async function runLoop() {
		if (running) return;
		running = true;
		stopFlag = false;
		const stopAwake = keepAwake(() => Lock.beat("outreach"));
		const run0 = await getRun();
		const job = run0.job;
		const st = await settings();
		const sheet = await get("orSheet");
		const sh = { done: run0.processed || 0, sent: run0.sent || 0, skipped: run0.skipped || 0, failed: run0.failed || 0, checked: run0.checked || 0, attempted: new Set(run0.attempted || []), sinceBreak: 0, errors: 0, sends: run0.sends || 0, chats: 0 };
		let breakAfter = nextBreak(st);
		let stop = null;
		let locked = false;
		let began = false;
		const publish = extra => patchRun({ processed: sh.done, sent: sh.sent, skipped: sh.skipped, failed: sh.failed, checked: sh.checked, sends: sh.sends, attempted: [...sh.attempted], ...(extra || {}) });
		publishNext = (ms, what) => publish({ nextAt: Date.now() + ms, waiting: what });

		try {
			if (!sheet) throw new Error("No rows loaded.");
			// One thing at a time on LinkedIn: wait for a reply sync or an Admin Reply to finish.
			locked = await Lock.acquire("outreach", {
				shouldStop: () => stopFlag,
				onWait: by => {
					log("info", `Waiting for ${Lock.NAMES[by] || by} to finish…`);
					return publish({ waiting: "lock", lockBy: by, nextAt: 0 });
				},
			});
			if (!locked) throw new Fatal("stopped", "Stopped while waiting.");
			await publish({ waiting: "", lockBy: "" });
			await LI.begin();
			began = true;
			if (job !== "check") await LI.me();
			while (!stopFlag && !stop) {
				if (job !== "check") {
					const cap = await capState(st);
					if (cap.reached) {
						stop = { kind: "cap", reason: `Auto-stopped at today's limit (${cap.today} requests sent today).` };
						break;
					}
				}
				const items = (await get("orItems")) || [];
				const it = nextItem(items, sh.attempted);
				if (!it) break;
				sh.attempted.add(it.key);
				await publish({ current: `row ${rowNo(it)}${it.name ? " · " + it.name : ""}`, nextAt: 0, waiting: "" });
				const tag = () => `[row ${rowNo(it)} · ${sh.done}/${run0.target}]`;
				let res;
				try {
					res = await processOne(it, job, st, sheet, { sends: sh.sends });
				} catch (e) {
					if (e instanceof Fatal) {
						sh.attempted.delete(it.key);
						stop = { kind: e.kind, reason: e.kind === "rate" ? `${e.message} Wait a few hours, then Continue with longer pauses.` : e.message };
						break;
					}
					await patchItem(it.key, { status: "failed", attempts: (it.attempts || 0) + 1, detail: e.message, checkedAt: Date.now() });
					sh.done++;
					sh.failed++;
					log("warn", `${tag()} ${it.name || it.id}: failed — ${e.message}`);
					if (++sh.errors >= MAX_CONSECUTIVE_ERRORS) stop = { kind: "errors", reason: `${sh.errors} rows failed in a row. Copy the log and send it over.` };
					await publish();
					await pause(rand(...S.SKIP_PAUSE) * 1000);
					continue;
				}
				if (job === "check" && res.patch && res.patch.status) {
					// Dry run: nothing changes status — the outcome is noted as "would …".
					const { status, detail, sentAt, noteSkip, noteHash, ...rest } = res.patch;
					res.patch = { ...rest, would: status === "skipped" ? `skip — ${detail}` : detail };
					res.summary = res.summary.replace(/^skipped — /, "would skip — ");
				}
				if (res.defer) {
					// Not done (stopped, or a send isn't allowed right now) — stays waiting.
					sh.attempted.delete(it.key);
					if (res.patch) await patchItem(it.key, res.patch);
					if (res.stop) stop = res.stop;
					break;
				}
				sh.errors = res.error ? sh.errors + 1 : 0;
				const done = job !== "check" && res.patch.status && res.patch.status !== "failed";
				// A finished row keeps only what the export needs (no dry-run note, no retry bookkeeping).
				await patchItem(it.key, { ...(done ? { attempts: undefined, uncertainAt: undefined, would: undefined } : {}), ...res.patch, ...(done ? { would: undefined, pid: undefined } : {}) });
				// The sheet: "Sent" + Sent Date — also for a request sent earlier or already pending
				// (res.mark). Other skipped / failed rows: nothing written.
				if (job !== "check" && res.patch.status === "sent") markSent(it, res.patch.sentAt || Date.now());
				else if (job !== "check" && res.mark) markSent(it, res.mark.sentAt);
				if (job !== "check" && res.patch.status === "sent" && res.sent) addActivity("request", res.patch.name || it.name || it.id);
				if (res.connected && job !== "check") sh.chats++;
				sh.done++;
				if (res.patch.status === "sent") sh.sent++;
				if (res.patch.status === "skipped") sh.skipped++;
				if (res.patch.status === "failed") sh.failed++;
				if (res.sent) sh.sends++;
				if (res.check && res.check.outcome !== "unknown") sh.checked++;
				log(res.level || "info", `${tag()} ${res.patch.name || it.name || it.id}: ${res.summary}`);
				if (res.stopAfter) stop = res.stopAfter;
				if (sh.errors >= MAX_CONSECUTIVE_ERRORS) stop = { kind: "errors", reason: `${sh.errors} rows in a row without a clear answer. Copy the log and send it over.` };
				await publish({ current: "" });
				if (stop || !nextItem((await get("orItems")) || [], sh.attempted)) break;

				// Pause before the next profile
				let wait;
				if (res.sent) {
					wait = rand(st.pauseMin, st.pauseMax);
					if (++sh.sinceBreak >= breakAfter) {
						sh.sinceBreak = 0;
						breakAfter = nextBreak(st);
						wait = rand(...S.BREAK_S);
						log("info", `Break of ${Math.round(wait)} s.`);
					}
				} else wait = res.noVisit ? rand(...NOVISIT_PAUSE) : rand(...S.SKIP_PAUSE);
				await publishNext(wait * 1000, "pause");
				await pause(wait * 1000);
			}
			if (stop) log(stop.kind === "cap" ? "warn" : "error", stop.kind === "cap" ? stop.reason : `Stopped: ${stop.reason}`);
			else if (stopFlag) log("info", "Stopped.");
		} catch (e) {
			if (e instanceof Fatal && e.kind === "stopped") log("info", "Stopped.");
			else {
				stop = e instanceof Fatal ? { kind: e.kind, reason: e.message } : { kind: "error", reason: e.message };
				log("error", e instanceof Fatal ? `Stopped: ${e.message}` : `Run crashed: ${e.message}`);
			}
		} finally {
			stopAwake();
			if (began) await LI.end();
			if (stop && stop.kind === "signedOut") await setLoggedOut("outreach");
			const finished = !stop && !stopFlag;
			const run = await publish({ active: false, current: "", nextAt: 0, waiting: "", lockBy: "", stopKind: stop ? stop.kind : stopFlag ? "stopped" : "", stopReason: stop ? stop.reason : "", finishedAt: finished ? Date.now() : 0, stoppedAt: Date.now() });
			await patchRun({ attempted: [] }); // only needed while running
			await chrome.storage.session.remove("orSession").catch(() => {});
			const mins = ((Date.now() - (run.startedAt || Date.now())) / 60000).toFixed(1);
			const c = await capState(st);
			log(
				"info",
				`${job === "check" ? "Dry run" : "Run"} ${finished ? "finished" : "stopped"} after ${mins} min: ${plural(sh.done, "row")}` +
					(job === "check" ? "" : `, ${plural(sh.sent, "request")} sent (${sh.checked} checked on LinkedIn), ${sh.skipped} skipped`) +
					`, ${sh.failed} failed. Today: ${plural(c.today, "request")} sent${c.limit ? ` (auto-stop at ${c.limit})` : ""}.`
			);
			running = false;
			if (locked) await Lock.release("outreach");
			if (sh.chats) {
				log("info", `${plural(sh.chats, "person", "people")} already connected — listed in To send, to send the message as a chat.`);
				Admin.refresh({ force: true }).catch(e => console.warn("[Outreach] To send:", e));
			}
		}
	}

	// opts: pastCap (Continue past today's auto-stop), confirmed (the "Send … ?" question was answered)
	async function startRun(job, opts = {}) {
		if (running) return { ok: false, error: "Already running." };
		if (await Control.isPaused()) return { ok: false, error: "Everything is paused — press “Start again” first." };
		const loaded = await loadSheet(); // the rows are read again at every Start
		if (!loaded.ok) return loaded;
		const sheet = await get("orSheet");
		const items = (await get("orItems")) || [];
		const st = await settings();
		const todo = items.filter(isTodo);
		if (!todo.length) return { ok: false, nothingToDo: true, error: "No rows are waiting. A row gets a request when its Outreach Status is empty or “Not Started” and it has a LinkedIn Profile and a Personalized Message." };
		if (job !== "check" && !sheet.statusValues.some(v => S.norm(v) === "sent")) return { ok: false, error: "Your Outreach Status dropdown has no “Sent” value, so sent rows couldn't be marked. Add it to the dropdown, then Start." };
		const ns = S.noteSetup(st, sheet.header);
		if (ns.error) return { ok: false, error: ns.error };
		if (job === "send" && !opts.confirmed && items.every(x => x.done || x.status === "pending")) return { ok: false, needConfirm: true, todo: todo.length, noteMode: st.noteMode, dailyCap: st.dailyCap };
		if (job !== "check") {
			const cap = await capState(st);
			if (cap.reached) {
				if (!opts.pastCap) return { ok: false, capReached: true, today: cap.today, dailyCap: st.dailyCap, error: `Today's auto-stop limit is reached (${cap.today} requests sent today).` };
				await grantMore();
				log("info", `Continuing past today's auto-stop: up to ${st.dailyCap} more requests today.`);
			}
		}
		await chrome.storage.session.set({ orSession: true });
		await patchRun({ active: true, job, target: todo.length, processed: 0, sent: 0, skipped: 0, failed: 0, checked: 0, sends: 0, attempted: [], current: "", startedAt: Date.now(), stopKind: "", stopReason: "", finishedAt: 0, stoppedAt: 0, nextAt: 0, waiting: "", lockBy: "" });
		const c = await capState(st);
		const first = nextItem(items, new Set());
		const head = job === "check" ? "DRY RUN (nothing is sent, nothing is written)" : "RUN";
		const what = `${plural(todo.length, "row")} from row ${rowNo(first)}`;
		const pace = job === "check" ? "" : ` · wait ${st.readMin}–${st.readMax}s on each profile, pause ${st.pauseMin}–${st.pauseMax}s · today ${c.today}${c.limit ? `/${c.limit}` : ""} requests`;
		log("start", `════════ ${head} — ${what}${pace} ════════`);
		runLoop();
		return { ok: true, target: todo.length };
	}

	async function stopRun() {
		stopFlag = true;
		await patchRun({ active: false });
	}

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && changes[RUN_KEY] && running) {
			const nv = changes[RUN_KEY].newValue;
			if (nv && !nv.active) stopFlag = true;
		}
	});

	// Chrome recycled the service worker mid-run → carry on; else clear a stale "active".
	async function resumeAfterRestart() {
		const run = await getRun();
		if (!run.active) return;
		const { orSession } = await chrome.storage.session.get("orSession");
		if (orSession) {
			log("info", "Service worker restarted — resuming.");
			await LI.adopt();
			runLoop();
		} else await patchRun({ active: false, current: "", waiting: "", lockBy: "" });
	}

	return {
		startRun,
		stopRun,
		loadSheet,
		importHistory,
		resumeAfterRestart,
		counts: async () => capState(await settings()),
		isRunning: () => running,
	};
})();
