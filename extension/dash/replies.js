// Replies: sync status, last sync, replies today, Start / Stop sync, Sync now, and the
// latest captured replies.
$("syncNow").innerHTML = `${ICON.refresh}Sync now`;

onRender(() => {
	if (tab !== "replies") return;
	const s = st.rsStatus || {};
	const paused = !!st.rtPaused;
	const stopped = !!st.syncStopped || paused;
	const syncing = !stopped && s.syncing && Date.now() - (s.heartbeatAt || 0) < STALE_SYNC_MS;

	let line;
	let cap = "";
	if (!configured()) {
		line = "Not set up";
		cap = "Connect your sheet in Settings.";
	} else if (paused) {
		line = "Paused";
		cap = "Press “Start again” at the top.";
	} else if (stopped) {
		line = "Stopped";
		cap = "Press Start sync to turn it back on.";
	} else if (syncing) {
		line = "Syncing now…";
		cap = s.progress || "";
	} else if (s.waitingFor) {
		line = `Waiting for ${BUSY[s.waitingFor] || "LinkedIn"}…`;
		cap = "Syncs right after it finishes.";
	} else {
		line = nextSyncAt > Date.now() ? `Next sync in ${Math.max(1, Math.round((nextSyncAt - Date.now()) / 60000))} min` : "Next sync soon";
		cap = "Every 20 minutes.";
	}
	$("rsLine").textContent = line;
	$("rsLineCap").textContent = cap;
	$("rsLast").textContent = s.lastSyncAt ? ago(s.lastSyncAt) : "never";
	$("rsLastCap").textContent = s.lastSyncAt ? timeOf(s.lastSyncAt) : "No sync yet.";
	const t = st.rsToday || {};
	$("rsToday").textContent = (t.day === startOfDay() ? t.n || 0 : 0).toLocaleString();

	const b = $("rsMain");
	b.className = st.syncStopped ? "btn primary" : "btn stop";
	setHTML(b, st.syncStopped ? `${ICON.play}Start sync` : `${ICON.stop}Stop sync`);
	b.disabled = !configured() || paused;
	$("syncNow").disabled = stopped || syncing || !configured();

	// Plain words; the numbers are in Details.
	const parts = [];
	if (s.lastError) parts.push(`<span class="err">${esc(s.lastError)}</span>`);
	else if (s.lastSyncAt) {
		const n = s.lastSent || 0;
		parts.push(n ? `<span class="ok">${plural(n, "new reply", "new replies")} added in the last sync ✓</span>` : "No new replies in the last sync.");
		if (s.lastFailed) parts.push(`<span class="err">${plural(s.lastFailed, "conversation")} couldn't be read — they're tried again next time.</span>`);
	} else if (s.lastSummary) parts.push(`<span class="muted">${esc(s.lastSummary)}</span>`);
	const box = st.rtOutbox || [];
	if (box.length) parts.push(`<span class="err">${plural(box.length, "change")} waiting to be written to your sheet — retrying every minute.</span>`);
	setHTML($("rsSummary"), parts.join("<br>") || '<span class="muted">The first sync runs once your sheet is connected.</span>');

	const recent = (st.rsRecent || []).slice(-20).reverse();
	$("rsRecentCount").textContent = recent.length ? `Latest ${recent.length}` : "";
	setHTML(
		$("rsRecent"),
		recent.length
			? `<ul class="replies">${recent
					.map(
						r =>
							`<li><a class="who" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name || "Someone")}</a><span class="t">${esc(timeOf(r.t || r.at))}</span><span class="text">${esc(r.text)}</span></li>`
					)
					.join("")}</ul>`
			: empty("chat", "No replies yet", "They'll appear here automatically.")
	);

	if ($("rsDetails").closest("details").open)
		$("rsDetails").textContent =
			`${s.lastSummary || "No sync yet."}${s.lastError ? `\nError: ${s.lastError}` : ""}${s.progress ? `\nNow: ${s.progress}` : ""}\n` +
			(box.length ? `Sheet writes waiting: ${box.map(j => `${j.action} ${j.label || ""} (${j.tries || 0} tries)`).join("; ")}\n` : "") +
			(st.rtSheetError ? `Sheet: ${st.rtSheetError.error} (${ago(st.rtSheetError.at)})\n` : "") +
			"Console: chrome://extensions → ReplyTrack → service worker, filter [ReplySync]; the pinned tab's console for each conversation.\n\n" +
			(st.rsLog || [])
				.slice(-30)
				.map(e => `${fmtTime(e.t)} ${e.msg}`)
				.join("\n");
});

$("rsMain").addEventListener("click", async () => {
	const starting = !!st.syncStopped;
	$("rsMain").disabled = true;
	const r = await send({ type: starting ? "startSync" : "stopSync" });
	if (!r || !r.ok) alert(`Could not ${starting ? "start" : "stop"} sync: ${(r && (r.reason || r.error)) || "no answer from the extension"}`);
	render();
});

$("syncNow").addEventListener("click", async () => {
	$("syncNow").disabled = true;
	$("rsLine").textContent = "Starting a sync…";
	const r = await send({ type: "syncNow" });
	if (!r || !r.ok) alert((r && (r.reason || r.error)) || "Could not start a sync.");
	else if (r.waiting) $("rsLineCap").textContent = r.reason;
});
