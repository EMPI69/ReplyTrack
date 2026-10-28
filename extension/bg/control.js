// "Pause everything" / "Start again" (popup header). Pause stops an outreach run, ends a
// reply sync, turns off automatic syncing and the accepted check, and cancels an Admin
// Reply that hasn't gone out yet. Start again turns back on what was running when you
// paused — an outreach run part-way through continues — but never starts a new run.
//
// storage.local  rtPaused { at, resume: { outreach: "send" | "check" | "", sync: bool } }
const Control = (() => {
	const KEY = "rtPaused";
	const isPaused = async () => !!(await getLocal(KEY, null));

	async function pause() {
		if (await isPaused()) return { ok: true };
		const run = await getLocal("orRun", {});
		const resume = { outreach: run.active ? run.job : "", sync: !(await getLocal("syncStopped", false)) };
		await chrome.storage.local.set({ [KEY]: { at: Date.now(), resume } });
		if (run.active) await Outreach.stopRun();
		await ReplySync.pause();
		await Admin.pause();
		orLog("info", "Paused everything (popup).");
		rsLog("info", "Paused everything (popup).");
		return { ok: true };
	}

	async function resume() {
		const p = await getLocal(KEY, null);
		await chrome.storage.local.remove(KEY);
		if (!p) return { ok: true };
		orLog("info", "Started again (popup).");
		rsLog("info", "Started again (popup).");
		const out = { ok: true };
		if (p.resume && p.resume.sync) ReplySync.ensureSyncTab("Start again").catch(e => console.warn("[ReplySync]", e));
		if (p.resume && p.resume.outreach) {
			const r = await Outreach.startRun(p.resume.outreach, { confirmed: true });
			if (!r.ok) out.note = `Outreach didn't continue: ${r.error}`;
		}
		Accepted.maybeRun("Start again").catch(e => console.warn("[Outreach]", e));
		return out;
	}

	return { isPaused, pause, resume };
})();
