// Loaded in <head>, so the saved light / dark theme applies before the page draws.
try {
	if (localStorage.getItem("rtTheme") === "light") document.documentElement.dataset.theme = "light";
} catch (e) {}
