// Runs before first paint so a chosen theme never flashes.
try {
  const theme = localStorage.getItem('board-web.theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {}
