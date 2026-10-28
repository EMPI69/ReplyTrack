// One thing at a time on LinkedIn. Owners:
//   "outreach"  — an outreach run or dry run (holds it for the whole run)
//   "replysync" — a reply sync in the pinned messaging tab
//   "accepted"  — the twice-a-day accepted check
//   "admin"     — sending an Admin Reply
//   "adminCheck"— looking up who's a connection yet, for the "To send" list
// Whoever holds it works; the others wait until it's released. An Admin Reply you're
// waiting on goes first; otherwise first come, first served. Kept in storage.session,
// so it survives the service worker restarting. A holder that stops beating for 3 minutes
// (crashed, tab closed) loses it.
const Lock = (() => {
	const KEY = "rtLock";
	const STALE_MS = 3 * 60 * 1000;
	const NAMES = { outreach: "outreach", replysync: "the reply sync", accepted: "the accepted check", admin: "an Admin Reply", adminCheck: "the connection check for To send" };
	const waiters = [];
	const releaseHooks = [];
	let chain = Promise.resolve();
	const serial = fn => (chain = chain.then(fn, fn));

	async function holder() {
		const { [KEY]: l } = await chrome.storage.session.get(KEY);
		if (!l) return null;
		if (Date.now() - (l.beatAt || 0) > STALE_MS) {
			await chrome.storage.session.remove(KEY);
			console.warn("[ReplySync] The lock held by %s went stale — released.", l.owner);
			return null;
		}
		return l;
	}

	const tryAcquire = owner =>
		serial(async () => {
			const l = await holder();
			if (l && l.owner !== owner) return false;
			if (!l && owner !== "admin" && waiters.some(w => w.owner === "admin")) return false; // an Admin Reply is waiting
			await chrome.storage.session.set({ [KEY]: { owner, since: l ? l.since : Date.now(), beatAt: Date.now() } });
			return true;
		});

	const beat = owner =>
		serial(async () => {
			const l = await holder();
			if (l && l.owner === owner) await chrome.storage.session.set({ [KEY]: { ...l, beatAt: Date.now() } });
		});

	async function release(owner) {
		const freed = await serial(async () => {
			const l = await holder();
			if (!l || l.owner !== owner) return false;
			await chrome.storage.session.remove(KEY);
			return true;
		});
		if (freed) setTimeout(() => releaseHooks.forEach(fn => Promise.resolve().then(() => fn(owner)).catch(e => console.warn("[ReplySync] after lock:", e))), 1500);
		return freed;
	}

	// Waits until it's free. false = shouldStop() said stop first. onWait(holder) on each change.
	async function acquire(owner, { shouldStop = () => false, onWait = () => {} } = {}) {
		const w = { owner };
		waiters.push(w);
		try {
			let told = null;
			for (;;) {
				if (await shouldStop()) return false;
				if (await tryAcquire(owner)) return true;
				const l = await holder();
				const by = l ? l.owner : "admin";
				if (by !== told) {
					told = by;
					await onWait(by);
				}
				await sleep(2000);
			}
		} finally {
			waiters.splice(waiters.indexOf(w), 1);
		}
	}

	return { tryAcquire, acquire, beat, release, holder, NAMES, onRelease: fn => releaseHooks.push(fn) };
})();
