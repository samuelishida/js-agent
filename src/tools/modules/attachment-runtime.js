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
        `${a.name} [${a.kind}] id=${a.id} (${a.mimeType}, ${a.size} bytes)`
      );
      return formatToolResult('attachment_list', list.join('\n') || '(no attachments)');
    }

    async function attachmentPreview({ id } = {}) {
      const a = state.attachments.get(String(id || ''));
      if (!a) throw new Error(`Attachment ${id} not found.`);
      const preview = a.textPreview
        ? a.textPreview.slice(0, 2000)
        : (a.kind === 'image' ? `[image: ${a.name}]` : '(no preview)');
      return formatToolResult('attachment_preview', `Attachment: ${a.name}\nId: ${a.id}\nKind: ${a.kind}\nMIME: ${a.mimeType}\nPreview:\n${preview}`);
    }

    async function attachmentReadText({ id, offset, limit } = {}) {
      const a = state.attachments.get(String(id || ''));
      if (!a) throw new Error(`Attachment ${id} not found.`);
      const source = a.textContent || a.textPreview || '';
      if (!source) throw new Error(`Attachment ${a.name} has no text content.`);
      const start = Math.max(0, Number(offset) || 0);
      const end = limit ? start + Math.max(1, Number(limit)) : undefined;
      const slice = source.slice(start, end);
      const footer = source.length > (end || slice.length) ? `\n\n[${source.length} total chars]` : '';
      return formatToolResult('attachment_read_text', slice.slice(0, 10000) + footer);
    }

    return {
      registerAttachments,
      attachmentList,
      attachmentPreview,
      attachmentReadText
    };
  };
})();
