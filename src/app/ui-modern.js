/**
 * Modern UI Handlers - Settings Modal Management Only
 * Session list, sidebar, and badge updates are handled in state.js and agent.js
 */

// Settings Modal Management
function openSettings() {
  const modal = document.getElementById('settings-modal');
  if (modal) {
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }
}

function closeSettings() {
  const modal = document.getElementById('settings-modal');
  if (modal) {
    modal.style.display = 'none';
    document.body.style.overflow = '';
  }
}

window.openSettings = openSettings;
window.closeSettings = closeSettings;

// Close modal on escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('settings-modal');
    if (modal && modal.style.display !== 'none') {
      closeSettings();
    }
  }
});
