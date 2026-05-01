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
window.openConfirmationPanel = openConfirmationPanel;
window.closeConfirmationPanel = closeConfirmationPanel;

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

  panel.classList.remove('hidden');
  list.innerHTML = pending.map((item, index) => `
    <div class="confirmation-item" data-sig-index="${index}">
      <div class="confirmation-item-icon">⚠️</div>
      <div class="confirmation-item-content">
        <div class="confirmation-item-title">${escHtml(item.tool || 'Unknown tool')}</div>
        <div class="confirmation-item-description">${escHtml(item.message || '')}</div>
        <div class="confirmation-item-actions">
          <button class="btn btn-approve btn-sm" data-action="approve" data-sig-index="${index}">Approve</button>
          <button class="btn btn-reject btn-sm" data-action="reject" data-sig-index="${index}">Reject</button>
        </div>
      </div>
    </div>
  `).join('');

  const signatures = pending.map(item => item.signature);
  list.addEventListener('click', function handler(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const idx = Number(btn.dataset.sigIndex);
    const sig = signatures[idx];
    if (sig === undefined) return;
    if (btn.dataset.action === 'approve') approveConfirmation(sig);
    else if (btn.dataset.action === 'reject') rejectConfirmation(sig);
  }, { once: true });
}

function closeConfirmationPanel() {
  const panel = document.getElementById('confirmation-panel');
  if (panel) panel.classList.add('hidden');
}

function approveConfirmation(signature) {
  if (window.AgentConfirmation?.approve) {
    window.AgentConfirmation.approve(signature);
    openConfirmationPanel(); // Re-render with updated list
  }
}

function rejectConfirmation(signature) {
  if (window.AgentConfirmation?.reject) {
    window.AgentConfirmation.reject(signature);
    const remaining = window.AgentConfirmation.pending?.() || [];
    if (remaining.length) {
      openConfirmationPanel();
    } else {
      closeConfirmationPanel();
    }
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
        window.AgentConfirmation?.reject?.(item.signature);
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
