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

// Confirmation Panel Handlers
function openConfirmationPanel() {
  const panel = document.getElementById('confirmation-panel');
  const list = document.getElementById('confirmation-list');
  if (!panel || !list) return;

  const pending = window.AgentConfirmation?.pending?.() || [];
  if (pending.length === 0) {
    closeConfirmationPanel();
    return;
  }

  panel.style.display = 'flex';
  list.innerHTML = pending.map((item, index) => `
    <div class="confirmation-item">
      <div class="confirmation-item-icon">⚠️</div>
      <div class="confirmation-item-content">
        <div class="confirmation-item-title">${escHtml(item.tool || 'Unknown tool')}</div>
        <div class="confirmation-item-description">${escHtml(item.message || '')}</div>
        <div class="confirmation-item-actions">
          <button class="btn btn-approve btn-sm" onclick="approveConfirmation('${item.signature}')">Approve</button>
          <button class="btn btn-reject btn-sm" onclick="rejectConfirmation('${item.signature}')">Reject</button>
        </div>
      </div>
    </div>
  `).join('');
}

function closeConfirmationPanel() {
  const panel = document.getElementById('confirmation-panel');
  if (panel) panel.style.display = 'none';
}

function approveConfirmation(signature) {
  if (window.AgentConfirmation?.approve) {
    window.AgentConfirmation.approve(signature);
    openConfirmationPanel(); // Re-render with updated list
  }
}

function rejectConfirmation(signature) {
  if (window.AgentConfirmation?.approve) {
    // For rejection, we don't call approve, just re-render
    openConfirmationPanel();
  }
}

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
  const closeBtn = document.getElementById('close-confirmation');
  const approveAllBtn = document.getElementById('approve-all');
  const rejectAllBtn = document.getElementById('reject-all');

  if (closeBtn) {
    closeBtn.addEventListener('click', closeConfirmationPanel);
  }

  if (approveAllBtn) {
    approveAllBtn.addEventListener('click', () => {
      const pending = window.AgentConfirmation?.pending?.() || [];
      for (const item of pending) {
        window.AgentConfirmation?.approve?.(item.signature);
      }
      closeConfirmationPanel();
    });
  }

  if (rejectAllBtn) {
    rejectAllBtn.addEventListener('click', () => {
      const pending = window.AgentConfirmation?.pending?.() || [];
      for (const item of pending) {
        // Rejection is implicit - just don't approve
      }
      closeConfirmationPanel();
    });
  }

  // Check for pending confirmations on page load
  openConfirmationPanel();
});

// Close modal on escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('settings-modal');
    if (modal && modal.style.display !== 'none') {
      closeSettings();
    }
  }
});
