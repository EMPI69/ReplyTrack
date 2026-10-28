// Overview: welcome, the four numbers, recent activity. ("How it works" is plain HTML.)
const ACTIVITY = {
	request: { accent: "blue", text: n => `Request sent to ${n}` },
	accepted: { accent: "amber", text: n => `${n} accepted your request` },
	reply: { accent: "purple", text: n => `Reply from ${n}` },
	admin: { accent: "green", text: n => `Admin reply sent to ${n}` },
	chat: { accent: "green", text: n => `Message sent to ${n}` },
};

onRender(() => {
	if (tab !== "overview") return;
	const who = memberName();
	$("memberName").textContent = who || cfg.tabName || "ReplyTrack";
	$("memberTab").textContent = !configured() ? "Not set up yet — connect your sheet in Settings." : who ? `Tab “${cfg.tabName}”` : `Tab “${cfg.tabName}” — add your name in the sheet's Team Member column to see it here.`;

	$("ovSent").textContent = (counts.today || 0).toLocaleString();
	$("ovSentCap").textContent = counts.limit ? `of ${counts.limit.toLocaleString()} daily limit` : "no daily limit";
	const w = st.acWeek || {};
	$("ovAccepted").textContent = (w.start === startOfWeek() ? w.n || 0 : 0).toLocaleString();
	const r = st.rsToday || {};
	$("ovReplies").textContent = (r.day === startOfDay() ? r.n || 0 : 0).toLocaleString();
	$("ovToSend").textContent = (st.adList || []).length.toLocaleString();

	const events = (st.rtActivity || []).slice(-10).reverse();
	$("activityCount").textContent = events.length ? `Latest ${events.length}` : "";
	setHTML(
		$("activity"),
		events.length
			? `<ul class="activity">${events
					.map(e => {
						const a = ACTIVITY[e.kind] || { accent: "blue", text: n => n };
						const extra = e.kind === "reply" && e.text ? `<small>“${esc(e.text.length > 70 ? e.text.slice(0, 70) + "…" : e.text)}”</small>` : "";
						return `<li data-accent="${a.accent}"><span class="k"></span><span class="what">${esc(a.text(e.name || "someone"))}${extra}</span><span class="t">${esc(timeOf(e.t))}</span></li>`;
					})
					.join("")}</ul>`
			: empty("clock", "No activity yet", "Requests, acceptances, replies and sent messages show up here as they happen.")
	);
});
