      const clock = document.getElementById('clock');
      const date = document.getElementById('date');
      const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
      function updateClock() {
        const now = new Date();
        clock.textContent = timeFormat.format(now);
        clock.dateTime = now.toISOString();
        date.textContent = dateFormat.format(now);
      }
      updateClock();
      setInterval(updateClock, 1000);
      document.getElementById('search').addEventListener('submit', (event) => {
        const value = document.getElementById('query').value.trim();
        if (!value) { event.preventDefault(); return; }
        const candidate = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
        try {
          const url = new URL(candidate);
          if (['https:', 'http:'].includes(url.protocol) && !value.includes(' ') && (url.hostname.includes('.') || url.hostname === 'localhost')) {
            event.preventDefault();
            location.assign(url.href);
          }
        } catch { /* Ordinary words and phrases go through the web search form. */ }
      });

const apps = document.getElementById('apps')
const status = document.getElementById('app-status')
async function nativeMessage(message) {
  return await chrome.runtime.sendNativeMessage('org.namzu.apps', message)
}
async function showApplications() {
  try {
    const result = await nativeMessage({ type: 'list' })
    if (!result?.ok || !Array.isArray(result.apps)) throw new Error('Catalogue unavailable')
    for (const app of result.apps) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'app'
      const icon = document.createElement('img')
      icon.src = app.icon
      icon.alt = ''
      icon.width = 44
      icon.height = 44
      const label = document.createElement('span')
      label.textContent = app.name
      button.append(icon, label)
      button.addEventListener('click', async () => {
        button.disabled = true
        status.textContent = `Opening ${app.name}…`
        try {
          const result = await nativeMessage({ type: 'launch', appId: app.id })
          status.textContent = result?.ok ? `${app.name} started` : `${app.name} could not be opened. Try again.`
        } catch {
          status.textContent = `${app.name} could not be opened. Try again.`
        } finally {
          button.disabled = false
        }
      })
      apps.append(button)
    }
  } catch {
    status.textContent = 'Application launchers are unavailable. The desktop dock is still available.'
  }
}
void showApplications()
