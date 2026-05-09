// src/tools/modules/attachment-runtime.js
// Attachment tools: list, preview, read_text, save. Publishes: window.AgentToolModules.createAttachmentRuntime

(() => {
  window.AgentToolModules = window.AgentToolModules || {};

  window.AgentToolModules.createAttachmentRuntime = function createAttachmentRuntime({
    state,
    formatToolResult
  }) {
    function registerAttachments(attachments) {
      if (!Array.isArray(attachments)) return;
      for (const a of attachments) {
        if (a?.id) state.attachments.set(a.id, a);
      }
    }

    async function attachmentList() {
      const list = Array.from(state.attachments.values()).map(a =>
        `${a.name} [${a.kind}] (${a.mimeType}, ${a.size} bytes)`
      );
      return formatToolResult('attachment_list', list.join('\n') || '(no attachments)');
    }

    async function attachmentPreview({ id } = {}) {
      const a = state.attachments.get(String(id || ''));
      if (!a) throw new Error(`Attachment ${id} not found.`);
      const preview = a.textPreview
        ? a.textPreview.slice(0, 2000)
        : (a.kind === 'image' ? `[image: ${a.name}]` : '(no preview)');
      return formatToolResult('attachment_preview', `Attachment: ${a.name}\nKind: ${a.kind}\nMIME: ${a.mimeType}\nPreview:\n${preview}`);
    }

    async function attachmentReadText({ id } = {}) {
      const a = state.attachments.get(String(id || ''));
      if (!a) throw new Error(`Attachment ${id} not found.`);
      if (!a.textPreview) throw new Error(`Attachment ${a.name} has no text preview.`);
      return formatToolResult('attachment_read_text', a.textPreview.slice(0, 10000));
    }

    return {
      registerAttachments,
      attachmentList,
      attachmentPreview,
      attachmentReadText
    };
  };
})();
