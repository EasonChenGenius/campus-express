function stopVisibleRefresh(page) {
  if (page._refreshTimer) clearInterval(page._refreshTimer);
  page._refreshTimer = null;
}

function startVisibleRefresh(page, refresh, intervalMs = 15000) {
  stopVisibleRefresh(page);
  page._refreshTimer = setInterval(() => {
    if (!page.data.loading && !page.data.busy && !page.data.busyId) refresh.call(page);
  }, intervalMs);
}

module.exports = { startVisibleRefresh, stopVisibleRefresh };
