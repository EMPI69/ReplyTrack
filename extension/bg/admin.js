// Admin Replies. Your manager writes a reply in the main sheet; it arrives in your sheet's
// "Admin Reply" column. The popup's "To send" tab lists every row whose Admin Reply has
// text that wasn't sent (or skipped) before. Nothing is ever sent automatically.
//
// Send (one at a time, after you confirm):
//   1. wait for the lock (outreach / reply sync / accepted check finish first — Cancel works)
//   2. look the row's own LinkedIn Profile up: it must be a 1st-degree connection
//   3. open your conversation with them: if you already sent this exact text there, stop
//      ("This message is already in the conversation" → Mark as sent)
//   4. a few seconds' pause, then the text goes into the history ("unconfirmed") and ONE
//      message is sent — never retried
//   5. the conversation is read back: only a message seen there counts. Then the history
//      says "sent" and Admin Reply + Response / Notes are cleared in that row (Sheet outbox).
//      Not seen / unclear answer → "Couldn't confirm" and you decide (It was sent / It wasn't).
//
// The history is per person and never expires: a text in it is never sent to that person
// again, and never shows in the list again (e.g. if the sheet sync copies a cleared Admin
// Reply back).
//
// Second kind of item, listed under the Admin Replies: "Already connected — send your
// message as a chat". An outreach run found that a waiting row's person (Outreach Status
// empty or "Not Started") is already a 1st-degree connection, so no request can be sent.
// The item shows the row's Personalized Message (placeholders filled, editable). Sending is
// exactly the same as above; once it's seen in the conversation the row gets Outreach
// Status "Sent" + today's Sent Date, and no cell is cleared. The same history applies.
//
// storage.local
//   adRows    { at, header, rows: [{ row, url, key, name, admin, notes }],
//               chats: [{ row, url, key, name, cells }] } — from the last read of the sheet
//   adList    the "To send" items (kind "admin" or "chat")
//   adConnected { <person>: { at, pid, firstName, lastName, headline } } — found by outreach runs
//   adHistory { <person>: [{ text, norm, at, state: "unconfirmed" | "sent", how, kind, row }] }
//   adSkipped { <person>: { <norm>: at } }
//   adJob     the send in progress, or one waiting for your answer (state below)
//   adNote    { <item id>: { text, kind, at } } — the last word on an item ("Not connected yet…")
//   adDegree  { <person>: { degree, at } }
//   orTplMessage  LinkedIn's message request, learned from a message you sent by hand
const Admin = (() => {
	const log = rsLog;
	const MAX_CHARS = 8000; // LinkedIn's message limit
	const DEGREE_TTL_MS = 12 * 3600e3; // re-check "not connected yet" after this long
	const MAX_LOOKUPS = 15; // connection lookups per round, at the normal pace
	const NOT_CONNECTED = "Not connected yet — LinkedIn only allows messages to connections";
	const UNCLEAR = "Couldn't confirm — check the conversation on LinkedIn";
	// Same as Code.gs: "[27 Oct 2026, 11:42 PM] text" entries in Response / Notes.
	const ENTRY_RE = /^\[(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4}), (\d{1,2}):(\d{2}) ?([AP])\.?M\.?\] ?([\s\S]*)$/i;
	const ENTRY_START_RE = /\n[ \t]*\n(?=\[\d{1,2} [A-Za-z]{3,9}\.? \d{4}, \d{1,2}:\d{2} ?[AP]\.?M\.?\])/i;
	// job states
	const BEFORE_SEND = new Set(["queued", "checking"]);
	const IN_FLIGHT = new Set(["sending", "verifying"]);
	// A {placeholder} still in a message (one the sheet couldn't fill).
	const PLACEHOLDER = /\{\{?\s*[A-Za-z][\w .\-]{0,40}?\s*\}\}?/;

	let chain = Promise.resolve();
	const serial = fn => (chain = chain.then(fn, fn));
	const clean = s => String(s || "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
	const dec = s => {
		try {
			return decodeURIComponent(String(s || ""));
		} catch (e) {
			return String(s || "");
		}
	};
	const when = t => new Date(t).toLocaleString([], { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

	// ---------------------------------------------------------------------------
	// History (per person, forever)
	// ---------------------------------------------------------------------------
	async function historyFor(person) {
		if (!person) return [];
		return (await getLocal("adHistory", {}))[person] || [];
	}
	const addHistory = (person, entries) =>
		serial(async () => {
			const h = await getLocal("adHistory", {});
			const list = (h[person] = h[person] || []);
			for (const e of [].concat(entries)) {
				const old = list.find(x => x.norm === e.norm);
				if (old) Object.assign(old, e);
				else list.push(e);
			}
			await chrome.storage.local.set({ adHistory: h });
		});
	const dropUnconfirmed = (person, norm) =>
		serial(async () => {
			const h = await getLocal("adHistory", {});
			if (!h[person]) return;
			h[person] = h[person].filter(x => !(x.norm === norm && x.state === "unconfirmed"));
			await chrome.storage.local.set({ adHistory: h });
		});

	// ---------------------------------------------------------------------------
	// The list
	// ---------------------------------------------------------------------------
	// The newest message in a Response / Notes cell → { when, text }.
	function latestEntry(notes) {
		const s = clean(notes);
		if (!s) return null;
		const parts = s.split(ENTRY_START_RE);
		const last = parts[parts.length - 1].trim();
		const m = last.match(ENTRY_RE);
		return m ? { when: last.slice(1, last.indexOf("]")), text: m[7] } : { when: "", text: last };
	}

	let lastRead = 0;
	async function refresh({ force = false } = {}) {
		if (!force && Date.now() - lastRead < 60000) return { ok: true, cached: true };
		lastRead = Date.now();
		const r = await Sheet.read();
		if (!r.ok) return r;
		const c = {};
		for (const k of ["profile", "name", "admin", "notes", "status", "message"]) c[k] = S.findCol(r.header, S.COLUMNS[k]);
		const connected = await getLocal("adConnected", {});
		const rows = [];
		const chats = [];
		const members = new Map(); // "Team Member" values → the dashboard's "Welcome back, <name>"
		const mc = S.findCol(r.header, S.COLUMNS.member);
		r.rows.forEach((cells, i) => {
			const m = mc >= 0 ? String(cells[mc] || "").trim() : "";
			if (m) members.set(m, (members.get(m) || 0) + 1);
			const url = String(cells[c.profile] || "").trim();
			const key = profileKey(url);
			const name = c.name >= 0 ? String(cells[c.name] || "").trim() : "";
			if (clean(cells[c.admin])) rows.push({ row: r.first + i, url, key, name, admin: String(cells[c.admin]), notes: String(cells[c.notes] || "") });
			// Already a connection, and the row is still waiting: its message can go as a chat.
			if (key && connected[key] && S.isSendable(cells[c.status]) && clean(cells[c.message])) chats.push({ row: r.first + i, url, key, name, cells });
		});
		await chrome.storage.local.set({ adRows: { at: Date.now(), header: r.header, rows, chats } });
		const member = [...members].sort((a, b) => b[1] - a[1]).map(x => x[0])[0] || "";
		if (member !== (await getLocal("rtMember", ""))) await chrome.storage.local.set({ rtMember: member });
		await rebuild();
		lookupDegrees().catch(e => console.warn("[ReplySync] connection lookups:", e));
		return { ok: true };
	}

	async function rebuild() {
		const s = await chrome.storage.local.get(["adRows", "adHistory", "adSkipped", "adDegree", "rsThreads", "adConnected"]);
		const rows = (s.adRows && s.adRows.rows) || [];
		const hist = s.adHistory || {};
		const skipped = s.adSkipped || {};
		const deg = s.adDegree || {};
		const threads = s.rsThreads || {};
		const items = [];
		const seen = new Set();
		const sentBefore = (k, n) => (hist[k] || []).some(h => h.norm === n && h.state === "sent");
		for (const r of rows) {
			const n = normText(r.admin);
			const k = r.key || `row${r.row}`;
			const id = `${k}|${hash(n)}`;
			if (seen.has(id)) continue; // the same person and text in two rows: one item
			seen.add(id);
			if (sentBefore(k, n)) continue; // sent before
			if ((skipped[k] || {})[n]) continue; // skipped until the text changes
			const d = deg[r.key];
			items.push({
				id,
				kind: "admin",
				key: r.key,
				row: r.row,
				url: r.url,
				name: r.name || (r.key ? r.key : `row ${r.row}`),
				admin: r.admin,
				notes: r.notes,
				latest: latestEntry(r.notes),
				noLink: !r.key,
				connected: d ? (d.degree === 1 ? "yes" : "no") : "unknown",
				thread: threads[r.key] || "",
			});
		}
		// "Already connected — send your message as a chat": one item per person (their first waiting row).
		const header = (s.adRows && s.adRows.header) || [];
		const msgCol = S.findCol(header, S.COLUMNS.message);
		const people = new Set();
		for (const ch of (s.adRows && s.adRows.chats) || []) {
			if (people.has(ch.key)) continue;
			people.add(ch.key);
			const f = S.fill(ch.cells[msgCol], S.withProfile(S.rowVars(header, ch.cells), (s.adConnected || {})[ch.key] || {}));
			const n = normText(f.text);
			if (!n || sentBefore(ch.key, n) || (skipped[ch.key] || {})[n]) continue;
			const d = deg[ch.key];
			items.push({
				id: `chat|${ch.key}|${hash(n)}`,
				kind: "chat",
				key: ch.key,
				row: ch.row,
				url: ch.url,
				name: ch.name || ch.key,
				admin: f.text, // the message to send (the field Admin Replies use for theirs)
				unfilled: [...f.missing, ...f.empty],
				connected: d && d.degree !== 1 ? "no" : "yes",
				thread: threads[ch.key] || "",
			});
		}
		await chrome.storage.local.set({ adList: items });
		chrome.action.setBadgeBackgroundColor({ color: "#0a66c2" }).catch(() => {});
		chrome.action.setBadgeText({ text: items.length ? String(items.length) : "" }).catch(() => {});
		return items;
	}

	// Is each listed person a connection yet? Looked up in the background, a few at a time,
	// at the normal pace, only when LinkedIn is free. Send checks again anyway.
	let looking = false;
	async function lookupDegrees() {
		if (looking || (await Control.isPaused()) || (await getLocal("adJob", null))) return;
		const list = await getLocal("adList", []);
		const deg = await getLocal("adDegree", {});
		const todo = list.filter(it => it.key && it.kind !== "chat" && !(deg[it.key] && (deg[it.key].degree === 1 || Date.now() - deg[it.key].at < DEGREE_TTL_MS))).slice(0, MAX_LOOKUPS);
		if (!todo.length || !(await Lock.tryAcquire("adminCheck"))) return;
		looking = true;
		const stopAwake = keepAwake(() => Lock.beat("adminCheck"));
		let began = false;
		try {
			await LI.begin();
			began = true;
			for (const [n, it] of todo.entries()) {
				if (n) await sleep(rand(...S.SKIP_PAUSE) * 1000);
				if ((await Control.isPaused()) || (await getLocal("adJob", null))) break; // a Send goes first
				const p = await LI.call({ type: "OR_PROFILE", identity: S.idFromCell(it.url) || it.key });
				if (p.ok) await saveDegree(it.key, p.rel && p.rel.self ? 0 : (p.rel && p.rel.degree) || null);
			}
		} catch (e) {
			if (e instanceof LI.Fatal && e.kind === "signedOut") await setLoggedOut("To send");
			console.warn("[ReplySync] Connection lookups for To send stopped:", e.message);
		} finally {
			stopAwake();
			if (began) await LI.end();
			looking = false;
			await Lock.release("adminCheck");
			await rebuild();
		}
	}
	const saveDegree = (person, degree) =>
		serial(async () => {
			const d = await getLocal("adDegree", {});
			d[person] = { degree, at: Date.now() };
			await chrome.storage.local.set({ adDegree: d });
		});

	// An outreach run found this row's person is already a connection (p = their profile,
	// for {firstName} etc. in the message). The list shows them after the next read of the sheet.
	async function noteConnected(url, p) {
		const key = profileKey(url);
		if (!key) return;
		await serial(async () => {
			const c = await getLocal("adConnected", {});
			c[key] = { at: Date.now(), pid: p.pid || "", firstName: p.firstName || "", lastName: p.lastName || "", headline: p.headline || "" };
			await chrome.storage.local.set({ adConnected: c });
		});
		await saveDegree(key, 1);
	}

	// ---------------------------------------------------------------------------
	// The job (one at a time)
	// ---------------------------------------------------------------------------
	const getJob = () => getLocal("adJob", null);
	const patchJob = (id, patch) =>
		serial(async () => {
			const j = await getJob();
			if (!j || j.id !== id) return null;
			const next = { ...j, ...patch };
			await chrome.storage.local.set({ adJob: next });
			return next;
		});
	const clearJob = id =>
		serial(async () => {
			const j = await getJob();
			if (j && j.id === id) await chrome.storage.local.remove("adJob");
		});
	const setNote = (id, note) =>
		serial(async () => {
			const notes = await getLocal("adNote", {});
			if (note) notes[id] = { ...note, at: Date.now() };
			else delete notes[id];
			await chrome.storage.local.set({ adNote: notes });
		});
	async function finish(id, note, line) {
		await setNote(id, note);
		await clearJob(id);
		if (line) log(note.kind === "error" ? "warn" : "info", line);
	}

	async function itemById(id) {
		return (await getLocal("adList", [])).find(x => x.id === id) || null;
	}

	// Send pressed (and confirmed in the popup).
	async function send({ id, text }) {
		if (await Control.isPaused()) return { ok: false, error: "Everything is paused — press “Start again” first." };
		const busy = await getJob();
		if (busy && busy.id !== id) return { ok: false, error: `Another reply (to ${busy.name}) is still in progress — one at a time.` };
		if (busy) return { ok: false, error: "This reply is already in progress." };
		const it = await itemById(id);
		if (!it) return { ok: false, error: "This reply is no longer in your sheet." };
		if (it.noLink) return { ok: false, error: "This row has no LinkedIn Profile link." };
		const body = clean(text == null ? it.admin : text);
		if (!body) return { ok: false, error: "The message is empty." };
		if ([...body].length > MAX_CHARS) return { ok: false, error: `The message is ${[...body].length} characters — LinkedIn allows ${MAX_CHARS}.` };
		const left = it.kind === "chat" && body.match(PLACEHOLDER);
		if (left) return { ok: false, error: `Fill in ${left[0]} first — the sheet had nothing for it.` };
		const dup = (await historyFor(it.key)).find(h => h.norm === normText(body));
		if (dup) return { ok: false, blocked: true, error: `You already sent this exact message to ${it.name} on ${when(dup.at)}.` };
		const job = { id, kind: it.kind || "admin", key: it.key, row: it.row, url: it.url, name: it.name, admin: it.admin, notes: it.notes || "", text: body, edited: normText(body) !== normText(it.admin), state: "queued", at: Date.now(), msg: "" };
		await chrome.storage.local.set({ adJob: job });
		await setNote(id, null);
		log("info", `Send pressed for ${it.name} (row ${it.row})${job.kind === "chat" ? " — message as a chat" : ""}${job.edited ? " — text edited" : ""}.`);
		runJob(id).catch(e => console.error("[ReplySync] Admin Reply:", e));
		return { ok: true };
	}

	// Their conversation? (The header link, or a sender link, is theirs; a group never is.)
	function isTheirs(t, person, pid, trusted) {
		if (t.isGroup) return false;
		const hrefs = [t.profileHref, ...(t.otherHrefs || [])].filter(Boolean);
		if (!hrefs.length) return !!trusted;
		const ids = [person, String(pid || "").toLowerCase()].filter(Boolean);
		return hrefs.some(h => ids.includes(profileKey(h)));
	}
	const sameThread = (t, thread) => !t.threadId || dec(t.threadId) === dec(thread);
	function sameText(seen, sent) {
		const a = normText(seen);
		const b = normText(sent);
		if (!a || !b) return false;
		if (a === b) return true;
		const head = b.slice(0, 200); // LinkedIn may show a link as a preview card below the text
		return head.length >= 30 && a.includes(head);
	}

	async function runJob(id) {
		const job = await getJob();
		if (!job || job.id !== id) return;
		const stopAwake = keepAwake(() => Lock.beat("admin"));
		let locked = false;
		let began = false;
		let posted = false;
		const cancelled = async () => {
			const j = await getJob();
			return !j || j.id !== id || !!j.cancelled || (await Control.isPaused());
		};
		try {
			locked = await Lock.acquire("admin", { shouldStop: cancelled, onWait: by => patchJob(id, { state: "queued", waitingFor: by }) });
			if (!locked) {
				await finish(id, { text: "Cancelled — nothing was sent.", kind: "info" }, `${job.name}: cancelled before sending.`);
				return;
			}
			await patchJob(id, { state: "checking", waitingFor: "", msg: "Checking the connection…" });
			await LI.begin();
			began = true;

			// 2. The person in THIS row, and a 1st-degree connection.
			const p = await LI.call({ type: "OR_PROFILE", identity: S.idFromCell(job.url) || job.key });
			if (!p.ok) return finish(id, { text: `Couldn't look ${job.name} up on LinkedIn: ${p.error}. Nothing was sent.`, kind: "error" }, `${job.name}: lookup failed — ${p.error}`);
			const rel = p.rel || {};
			await saveDegree(job.key, rel.self ? 0 : rel.degree || null);
			if (rel.self) return finish(id, { text: "This row's LinkedIn Profile is your own profile. Nothing was sent.", kind: "error" });
			if (rel.degree !== 1) return finish(id, { text: NOT_CONNECTED, kind: "notConnected" }, `${job.name}: not a 1st-degree connection — not sent.`);
			const me = await LI.me();
			if (!me) return finish(id, { text: "Couldn't read your own LinkedIn profile id — try again in a minute. Nothing was sent.", kind: "error" });

			// 3. Your conversation with them: already sent by hand?
			const known = (await getLocal("rsThreads", {}))[job.key] || "";
			let thread = known;
			if (!thread) {
				const f = await LI.call({ type: "OR_FIND_THREAD", pid: p.pid });
				if (f.ok && f.thread) thread = f.thread;
			}
			if (thread) {
				await patchJob(id, { msg: "Checking your conversation…" });
				const t = await LI.readThread(thread);
				if (!t.ok) return finish(id, { text: `Couldn't open your conversation with ${job.name} to check it (${t.error}). Nothing was sent — try again.`, kind: "error" }, `${job.name}: conversation check failed — ${t.error}`);
				if (sameThread(t, thread) && isTheirs(t, job.key, p.pid, thread === known)) {
					if (t.mine.some(m => sameText(m, job.text))) {
						await patchJob(id, { state: "already", thread, msg: "This message is already in the conversation" });
						log("info", `${job.name}: this exact message is already in the conversation — not sent.`);
						return;
					}
				} else {
					log("info", `${job.name}: conversation ${thread} isn't the one with them — sending to the person instead.`);
					thread = "";
				}
			}

			// 4. A human pause, then ONE message. Saved first: it's never sent to them again by itself.
			const st = { ...S.DEFAULTS, ...((await getLocal("orSettings", {})) || {}) };
			await patchJob(id, { msg: "Sending in a few seconds…" });
			await sleep(rand(st.readMin, st.readMax) * 1000);
			if (await cancelled()) return finish(id, { text: "Cancelled — nothing was sent.", kind: "info" }, `${job.name}: cancelled before sending.`);
			await addHistory(job.key, { text: job.text, norm: normText(job.text), at: Date.now(), state: "unconfirmed", how: "sent", kind: job.kind || "admin", edited: job.edited, row: job.row });
			await patchJob(id, { state: "sending", msg: "Sending…" });
			const r = await LI.call({ type: "OR_MESSAGE", pid: p.pid, me, thread: thread ? dec(thread) : "", text: job.text, learned: await learnedMessage() });
			await scoreMessage(r.learnedResult);
			const trail = r.log && r.log.length ? ` [${r.log.join("; ")}]` : "";
			if (!r.ok && r.code !== "uncertain") {
				// A clear "no" from LinkedIn: nothing was sent.
				await dropUnconfirmed(job.key, normText(job.text));
				const nc = r.code === "notConnected";
				return finish(id, { text: nc ? NOT_CONNECTED : `LinkedIn didn't send it: ${r.error}`, kind: nc ? "notConnected" : "error" }, `${job.name}: not sent — ${r.error}${trail}`);
			}
			posted = true;
			log(r.ok ? "info" : "warn", `${job.name}: ${r.ok ? "LinkedIn accepted the message" : "unclear answer from LinkedIn"}${trail} — checking the conversation.`);
			let where = r.thread || thread;
			if (r.ok && !where) {
				// A new conversation whose id wasn't in LinkedIn's answer: look it up (a read, never a resend).
				const f = await LI.call({ type: "OR_FIND_THREAD", pid: p.pid }).catch(() => ({}));
				where = (f && f.thread) || "";
			}

			// 5. Read it back. Reading again is fine; sending again never happens.
			let verified = false;
			if (r.ok && where) {
				await patchJob(id, { state: "verifying", thread: where, msg: "Checking it arrived…" });
				await sleep(rand(3, 5) * 1000);
				const seen = v => v.ok && sameThread(v, where) && isTheirs(v, job.key, p.pid, true) && v.mine.some(m => sameText(m, job.text));
				let v = await LI.readThread(where);
				if (!seen(v)) {
					await sleep(5000);
					v = await LI.readThread(where);
				}
				verified = seen(v);
			}
			if (verified) {
				await markSent(job, "sent");
				await rememberThread(job.key, where);
				await clearJob(id);
				log("info", `${job.name}: ✓ ${afterSend(job)}`);
				return;
			}
			await patchJob(id, { state: "unclear", thread: where || "", msg: UNCLEAR });
			log("warn", `${job.name}: ${UNCLEAR}. Nothing is sent again by itself — answer “It was sent” or “It wasn't sent” in To send.`);
		} catch (e) {
			if (e instanceof LI.Fatal && e.kind === "signedOut") await setLoggedOut("Admin Reply");
			if (posted) {
				await patchJob(id, { state: "unclear", msg: UNCLEAR });
				log("warn", `${job.name}: ${UNCLEAR} (${e.message}).`);
			} else {
				await dropUnconfirmed(job.key, normText(job.text));
				await finish(id, { text: `Not sent: ${e.message}`, kind: "error" }, `${job.name}: not sent — ${e.message}`);
			}
		} finally {
			stopAwake();
			if (began) await LI.end();
			if (locked) await Lock.release("admin");
		}
	}

	async function rememberThread(person, thread) {
		if (!person || !thread) return;
		const threads = await getLocal("rsThreads", {});
		threads[person] = thread;
		await chrome.storage.local.set({ rsThreads: threads });
	}

	const afterSend = job =>
		job.kind === "chat"
			? `message sent as a chat and seen in the conversation — row ${job.row} gets Outreach Status “Sent” and today's Sent Date.`
			: `Admin Reply sent and seen in the conversation — clearing Admin Reply and Response / Notes in row ${job.row}.`;

	// Sent (seen in the conversation, or you said so): history "sent", then the sheet —
	//   Admin Reply: Admin Reply and Response / Notes are cleared in that row;
	//   chat:        Outreach Status "Sent" + today's Sent Date when this extension sent it;
	//                Sent Date left empty when it was found already in the conversation or you
	//                marked it "Already sent by hand" (when it was sent isn't known). Nothing cleared.
	// An edited text also retires the original.
	async function markSent(job, how) {
		const at = Date.now();
		const kind = job.kind === "chat" ? "chat" : "admin";
		const byExtension = how === "sent" || how === "confirmed by you";
		const entries = [{ text: job.text, norm: normText(job.text), at, state: "sent", how, kind, edited: !!job.edited, row: job.row }];
		if (job.edited) entries.push({ text: clean(job.admin), norm: normText(job.admin), at, state: "sent", how: "replaced by the edited text", kind, row: job.row });
		await addHistory(job.key, entries);
		if (byExtension) addActivity(kind, job.name);
		if (kind === "chat") await Sheet.enqueue("markSent", { profileUrl: job.url, sentAt: byExtension ? at : null }, `${job.name} (row ${job.row}) — chat`);
		else await Sheet.enqueue("clearAdmin", { profileUrl: job.url, row: job.row, adminText: job.admin, notesText: job.notes }, `${job.name} (row ${job.row})`);
		await setNote(job.id, null);
		await rebuild();
	}

	// "It was sent" / "It wasn't sent" (after "Couldn't confirm").
	async function answerUnclear({ id, sent }) {
		const job = await getJob();
		if (!job || job.id !== id || job.state !== "unclear") return { ok: false, error: "Nothing to answer for this reply." };
		if (sent) {
			await markSent(job, "confirmed by you");
			log("info", `${job.name}: you confirmed it was sent — ${job.kind === "chat" ? `row ${job.row} gets “Sent” and today's Sent Date` : `clearing the cells in row ${job.row}`}.`);
		} else {
			await dropUnconfirmed(job.key, normText(job.text));
			await setNote(id, { text: "Marked as not sent — you can send it again.", kind: "info" });
			log("info", `${job.name}: you said the Admin Reply wasn't sent — it can be sent again.`);
		}
		await clearJob(id);
		return { ok: true };
	}

	// "Mark as sent" (it's already in the conversation) and "Already sent by hand".
	async function sentByHand({ id, text }) {
		const job = await getJob();
		if (job && job.id === id && job.state === "already") {
			await markSent(job, "found in the conversation");
			await clearJob(id);
			log("info", `${job.name}: marked as sent (it was already in the conversation).`);
			return { ok: true };
		}
		if (job && job.id === id) return { ok: false, error: "This reply is in progress." };
		const it = await itemById(id);
		if (!it) return { ok: false, error: "This reply is no longer in your sheet." };
		const body = clean(text == null ? it.admin : text) || clean(it.admin);
		await markSent({ id, kind: it.kind || "admin", key: it.key || `row${it.row}`, row: it.row, url: it.url, name: it.name, admin: it.admin, notes: it.notes || "", text: body, edited: normText(body) !== normText(it.admin) }, "by hand");
		log("info", `${it.name}: marked as already sent by hand — nothing sent; ${it.kind === "chat" ? `row ${it.row} gets “Sent” with the Sent Date left empty` : `Admin Reply and Response / Notes cleared in row ${it.row}`}.`);
		return { ok: true };
	}

	// Skip: hidden until the Admin Reply text changes.
	async function skip({ id }) {
		const it = await itemById(id);
		if (!it) return { ok: false, error: "This reply is no longer in your sheet." };
		const job = await getJob();
		if (job && job.id === id) return { ok: false, error: "This reply is in progress." };
		await serial(async () => {
			const s = await getLocal("adSkipped", {});
			const k = it.key || `row${it.row}`;
			(s[k] = s[k] || {})[normText(it.admin)] = Date.now();
			await chrome.storage.local.set({ adSkipped: s });
		});
		await setNote(id, null);
		await rebuild();
		return { ok: true };
	}

	// Cancel: only before the message goes out.
	async function cancel({ id }) {
		const job = await getJob();
		if (!job || job.id !== id) return { ok: true };
		if (job.state === "already") {
			await clearJob(id);
			return { ok: true };
		}
		if (!BEFORE_SEND.has(job.state)) return { ok: false, error: "It's being sent — too late to cancel." };
		await patchJob(id, { cancelled: true, msg: "Cancelling…" });
		return { ok: true };
	}

	// "Pause everything": a send that hasn't gone out yet is cancelled.
	async function pause() {
		const job = await getJob();
		if (job && BEFORE_SEND.has(job.state)) await patchJob(job.id, { cancelled: true });
	}

	// After a service worker restart: the job's own code is gone.
	async function recover() {
		const job = await getJob();
		if (!job) return;
		if (BEFORE_SEND.has(job.state)) await finish(job.id, { text: "Interrupted before sending — nothing was sent. Press Send again.", kind: "info" });
		else if (IN_FLIGHT.has(job.state)) {
			await patchJob(job.id, { state: "unclear", msg: UNCLEAR });
			log("warn", `${job.name}: the extension restarted while sending — ${UNCLEAR}.`);
		}
	}

	// ---------------------------------------------------------------------------
	// Self-repair: when YOU send a message by hand (any LinkedIn tab except the worker
	// tab), LinkedIn's own request is saved as a template and tried first for Admin
	// Replies. Your text is replaced by a placeholder before it's saved.
	// ---------------------------------------------------------------------------
	const LEARN_URLS = ["https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages*", "https://www.linkedin.com/voyager/api/messaging/conversations*"];
	const PER_REQUEST = /^(csrf-token|x-li-traceparent|x-li-tracestate|x-li-pageforestid|x-li-page-instance-tracking-id|content-length|cookie|origin|referer|user-agent|sec-.*|accept-encoding|accept-language|connection|host)$/i;
	const COPY_HEADER = /^(accept|content-type|x-li-[\w-]+|x-restli-protocol-version)$/i;
	const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
			if (!/createMessage|action=create|\/events/i.test(path)) return;
			const body = LI.rawBody(d.requestBody);
			if (!/"text"\s*:/.test(body)) return;
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
			if (d.statusCode >= 200 && d.statusCode < 300) learnMessage(c).catch(e => console.warn("[ReplySync] learn failed", e));
		},
		{ urls: LEARN_URLS, types: ["xmlhttprequest"] }
	);
	chrome.webRequest.onErrorOccurred.addListener(d => caught.delete(d.requestId), { urls: LEARN_URLS });

	async function learnMessage(c) {
		if (LI.isWorker(c.tabId)) return;
		const old = await getLocal("orTplMessage", null);
		if (old && !old.fail && Date.now() - (old.learnedAt || 0) < 7 * DAY_MS) return; // a working one is kept
		const me = await getLocal("orMe", null);
		if (!me || !me.pid) return;
		let j;
		try {
			j = JSON.parse(c.body);
		} catch (e) {
			return;
		}
		// Your text → {{TEXT}}; one-off tokens → fresh per send.
		let textSlot = false;
		(function walk(o) {
			if (!o || typeof o !== "object") return;
			for (const [k, v] of Object.entries(o)) {
				if (typeof v === "string") {
					if (k === "text" && v.trim() && !/^urn:/.test(v)) {
						o[k] = "{{TEXT}}";
						textSlot = true;
					} else if (/^(originToken|clientGeneratedToken|dedupeToken)$/.test(k)) o[k] = "{{UUID}}";
					else if (k === "trackingId") o[k] = "{{TRACKING}}";
				} else if (v && typeof v === "object") walk(v);
			}
		})(j);
		if (!textSlot) return;
		let url = c.url;
		let body = JSON.stringify(j);
		// The conversation → {{THREAD}}; you → {{ME}}; them → {{PROFILE_ID}}.
		const threadSlot = s =>
			s
				.replace(/(msg_conversation:\(urn:li:fsd_profile:)[\w-]+,[^)"\\]+\)/g, "$1{{ME}},{{THREAD}})")
				.replace(/messagingThread:[^"\\,)\s]+/g, "messagingThread:{{THREAD}}")
				.replace(/fs_conversation:[^"\\,)\s]+/g, "fs_conversation:{{THREAD}}")
				.replace(/(\/conversations\/)[^/?]+/g, "$1{{THREAD}}");
		url = threadSlot(url);
		body = threadSlot(body);
		const ids = [...new Set([...(url + " " + body).matchAll(/fsd_profile:(ACoA[\w-]{10,})/g)].map(m => m[1]))];
		if (ids.filter(x => x !== me.pid).length > 1) return; // a group message — can't tell who's who
		for (const id of ids) {
			const re = new RegExp(esc(id), "g");
			const slot = id === me.pid ? "{{ME}}" : "{{PROFILE_ID}}";
			url = url.replace(re, slot);
			body = body.replace(re, slot);
		}
		// Never keep a template that still names one particular conversation or person.
		if (/2-[A-Za-z0-9_\-+/=]{16,}|ACoA[\w-]{10,}/.test(url + body)) return;
		if (!/\{\{(THREAD|PROFILE_ID)\}\}/.test(url + body)) return;
		const headers = {};
		for (const h of c.headers || []) {
			const k = h.name.toLowerCase();
			if (COPY_HEADER.test(k) && !PER_REQUEST.test(k) && h.value) headers[k] = h.value;
		}
		await chrome.storage.local.set({ orTplMessage: { method: "POST", url, body, headers, learnedAt: Date.now(), fail: 0 } });
		log("info", `Learned LinkedIn's own message request from a message you sent by hand (${url.split("?")[0]}) — it's tried first for Admin Replies from now on.`);
	}

	async function learnedMessage() {
		const t = await getLocal("orTplMessage", null);
		return t && (t.fail || 0) < 3 ? t : null;
	}
	async function scoreMessage(result) {
		if (!result) return;
		const t = await getLocal("orTplMessage", null);
		if (!t) return;
		t.fail = result === "ok" ? 0 : (t.fail || 0) + 1;
		await chrome.storage.local.set({ orTplMessage: t });
		if (t.fail === 3) log("warn", "The learned message request failed 3 times — using the built-in one. Send one message by hand to learn the current one.");
	}

	return { historyFor, refresh, rebuild, send, answerUnclear, sentByHand, skip, cancel, pause, recover, lookupDegrees, noteConnected };
})();
