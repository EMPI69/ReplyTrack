// Accepted check: twice a day (around 10 AM and 4 PM — or the next time Chrome is open
// after that), rows whose Outreach Status is "Sent", whose Response / Notes is empty and
// whose Sent Date is in the last 30 days are compared with your "recently added"
// connections list on LinkedIn (a few requests, not one per row). Someone on that list
// accepted: "Accepted but not replied" goes into their Response / Notes.
// Waits for the lock like everything else on LinkedIn, and is off while paused.
//
// storage.local  acStatus { lastRunAt, lastTryAt, summary, error, found }
const Accepted = (() => {
	const log = orLog;
	const SLOTS = [10, 16]; // local hours
	const MAX_AGE_DAYS = 30; // rows sent longer ago aren't checked any more
	const PAGE = 40; // connections per request
	const MAX_PAGES = 10;
	const STATUS = "acStatus";
	let running = false;
	let pending = false;

	const setStatus = async patch => chrome.storage.local.set({ [STATUS]: { ...(await getLocal(STATUS, {})), ...patch } });

	// The latest 10 AM / 4 PM that has passed.
	function lastSlot(now = Date.now()) {
		const d = new Date(now);
		const today = SLOTS.map(h => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime()).filter(t => t <= now);
		return today.length ? Math.max(...today) : new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, SLOTS[SLOTS.length - 1]).getTime();
	}

	async function maybeRun(reason) {
		const st = await getLocal(STATUS, {});
		if ((st.lastRunAt || 0) < lastSlot() || pending) return run(reason);
	}

	// Sent Date: a real date from the sheet, or a date typed as text ("24 Oct 2026").
	function sentTime(ms, shown) {
		if (ms) return ms;
		const t = Date.parse(String(shown || "").trim());
		return isNaN(t) ? 0 : t;
	}

	async function run(reason) {
		if (running) return { ok: false, error: "The accepted check is already running." };
		if (await Control.isPaused()) return { ok: false, error: "Everything is paused." };
		if (!Sheet.configured(await Sheet.settings())) return { ok: false, error: "Not set up yet." };
		if (!(await Lock.tryAcquire("accepted"))) {
			pending = true; // runs when the lock is free (onLockFree)
			return { ok: true, waiting: true };
		}
		pending = false;
		running = true;
		const stopAwake = keepAwake(() => Lock.beat("accepted"));
		let began = false;
		await setStatus({ lastTryAt: Date.now(), running: true });
		try {
			const r = await Sheet.read();
			if (!r.ok) throw new Error(`couldn't read your sheet: ${r.error}`);
			const c = {};
			for (const k of ["profile", "status", "notes", "sentDate", "name"]) c[k] = S.findCol(r.header, S.COLUMNS[k]);
			const oldest = Date.now() - MAX_AGE_DAYS * DAY_MS;
			const rows = [];
			r.rows.forEach((cells, i) => {
				if (S.norm(cells[c.status]) !== "sent" || String(cells[c.notes] || "").trim()) return;
				const sent = sentTime(r.sentMs && r.sentMs[i], cells[c.sentDate]);
				const key = profileKey(cells[c.profile]);
				if (key && sent >= oldest) rows.push({ row: r.first + i, key, url: cells[c.profile], sent, name: c.name >= 0 ? String(cells[c.name] || "").trim() : "" });
			});
			if (!rows.length) {
				await setStatus({ lastRunAt: Date.now(), summary: `Nothing to check — no “Sent” rows from the last ${MAX_AGE_DAYS} days with an empty Response / Notes.`, error: "", found: 0 });
				return { ok: true, found: 0 };
			}
			log("info", `Accepted check (${reason}): ${plural(rows.length, "row")} to look for in your recently added connections.`);
			await LI.begin();
			began = true;
			const since = Math.min(...rows.map(x => x.sent)) - 2 * DAY_MS;
			const connected = new Set();
			let pages = 0;
			for (let start = 0; pages < MAX_PAGES; start += PAGE) {
				if (pages) await sleep(rand(...S.SKIP_PAUSE) * 1000); // human-like pace between pages
				if (await Control.isPaused()) throw new Error("paused");
				const res = await LI.call({ type: "OR_CONNECTIONS", start, count: PAGE });
				pages++;
				if (!res.ok) throw new Error(res.error);
				for (const x of res.list) {
					if (x.publicId) connected.add(String(x.publicId).toLowerCase());
					if (x.pid) connected.add(String(x.pid).toLowerCase());
				}
				if (res.list.length < PAGE) break;
				const times = res.list.map(x => x.createdAt).filter(Boolean);
				if (times.length ? Math.min(...times) < since : pages >= 3) break; // older than every row we look for
			}
			const hits = new Map();
			for (const x of rows) if (connected.has(x.key) && !hits.has(x.key)) hits.set(x.key, x);
			for (const x of hits.values()) {
				await Sheet.enqueue("markAccepted", { profileUrl: x.url }, `row ${x.row}`);
				addActivity("accepted", x.name || x.key);
			}
			if (hits.size) {
				const week = startOfWeek();
				const w = await getLocal("acWeek", {});
				await chrome.storage.local.set({ acWeek: { start: week, n: (w.start === week ? w.n || 0 : 0) + hits.size } });
			}
			const summary = `${hits.size ? `${plural(hits.size, "person", "people")} accepted` : "No new acceptances"} (checked ${plural(rows.length, "row")} against ${plural(connected.size, "recent connection")}, ${plural(pages, "request")}).`;
			log("info", `Accepted check: ${summary}`);
			await setStatus({ lastRunAt: Date.now(), summary, error: "", found: hits.size });
			return { ok: true, found: hits.size };
		} catch (e) {
			if (e instanceof LI.Fatal && e.kind === "signedOut") await setLoggedOut("accepted check");
			const error = e.message === "paused" ? "Paused." : e.message;
			log("warn", `Accepted check didn't finish: ${error}`);
			await setStatus({ error });
			return { ok: false, error };
		} finally {
			stopAwake();
			if (began) await LI.end();
			await setStatus({ running: false });
			running = false;
			await Lock.release("accepted");
		}
	}

	async function onLockFree(owner) {
		if (owner !== "accepted" && pending) await run("after " + (Lock.NAMES[owner] || owner));
	}

	return { maybeRun, run, onLockFree };
})();
