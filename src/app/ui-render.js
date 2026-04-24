;(function() {
  var SAFE_HTML_TAGS = new Set([
    'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's',
    'ul', 'ol', 'li', 'code', 'pre', 'blockquote',
    'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'h1', 'h2', 'h3', 'h4', 'hr', 'div', 'span'
  ]);

  var SAFE_HTML_ATTRS = {
    a: new Set(['href', 'title']),
    th: new Set(['colspan', 'rowspan']),
    td: new Set(['colspan', 'rowspan'])
  };

  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function containsMarkdown(text) {
    var s = String(text || '');
    return (
      /^#{1,4}\s+\S/m.test(s)       ||
      /^\s*\|.+\|\s*$/m.test(s)     ||
      /^```/m.test(s)                ||
      /^\s*[-*+]\s+\S/m.test(s)     ||
      /^\s*\d+\.\s+\S/m.test(s)     ||
      /\*\*[^*\n]+\*\*/m.test(s)    ||
      /`[^`\n]+`/.test(s)            ||
      /^\s*>/m.test(s)               ||
      /^---+\s*$/m.test(s)
    );
  }

  function looksLikeHtmlFragment(text) {
    return /<\/?[a-z][^>]*>/i.test(String(text || ''));
  }

  function escapeInlineHtml(text) {
    return escHtml(String(text || ''));
  }

  function renderInlineMarkdown(text) {
    var value = escapeInlineHtml(text);
    value = value.replace(/`([^`]+)`/g, '<code>$1</code>');
    value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+|tel:[^\s)]+)\)/g, '<a href="$2">$1</a>');
    value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    value = value.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    value = value.replace(/(^|[^\*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    value = value.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
    return value;
  }

  function renderMarkdownBlocks(text) {
    var source = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!source) return '<p></p>';

    var lines = source.split('\n');
    var html = [];
    var i = 0;

    var isUl = function(line) { return /^(\s*[-*+]\s+)/.test(line); };
    var isOl = function(line) { return /^(\s*\d+\.\s+)/.test(line); };
    var isQuote  = function(line) { return /^\s*>\s?/.test(line); };
    var isTableRow = function(line) { return /^\s*\|.+\|\s*$/.test(line); };
    var isTableSep = function(line) { return /^\s*\|[\s|:-]+\|\s*$/.test(line); };

    while (i < lines.length) {
      var line = lines[i];
      var trimmed = line.trim();

      if (!trimmed) {
        i++;
        continue;
      }

      var fence = trimmed.match(/^```([\w-]+)?\s*$/);
      if (fence) {
        var lang = fence[1] ? ' class="language-' + escapeInlineHtml(fence[1]) + '"' : '';
        var chunk = [];
        i++;
        while (i < lines.length && !lines[i].trim().match(/^```\s*$/)) {
          chunk.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++;
        html.push('<pre><code' + lang + '>' + escapeInlineHtml(chunk.join('\n')) + '</code></pre>');
        continue;
      }

      if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
        html.push('<hr>');
        i++;
        continue;
      }

      var heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        var level = heading[1].length;
        html.push('<h' + level + '>' + renderInlineMarkdown(heading[2]) + '</h' + level + '>');
        i++;
        continue;
      }

      if (isQuote(line)) {
        var qchunk = [];
        while (i < lines.length && isQuote(lines[i])) {
          qchunk.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        html.push('<blockquote>' + qchunk.map(function(item) { return '<p>' + renderInlineMarkdown(item) + '</p>'; }).join('') + '</blockquote>');
        continue;
      }

      if (isTableRow(line)) {
        var tableLines = [];
        while (i < lines.length && (isTableRow(lines[i]) || isTableSep(lines[i]))) {
          tableLines.push(lines[i]);
          i++;
        }

        var parseRow = function(raw) { return raw.trim().replace(/^\||\|$/g, '').split('|').map(function(cell) { return cell.trim(); }); };

        var hasSep = tableLines.some(function(l) { return isTableSep(l); });
        var headerRow = parseRow(tableLines[0]);
        var bodyRows;
        if (hasSep) {
          bodyRows = tableLines.slice(1).filter(function(l) { return !isTableSep(l); }).map(parseRow);
        } else {
          bodyRows = tableLines.slice(1).map(parseRow);
        }

        var tableHtml = '<table><thead><tr>';
        headerRow.forEach(function(cell) {
          tableHtml += '<th>' + renderInlineMarkdown(cell) + '</th>';
        });
        tableHtml += '</tr></thead>';
        if (bodyRows.length) {
          tableHtml += '<tbody>';
          bodyRows.forEach(function(row) {
            tableHtml += '<tr>';
            row.forEach(function(cell) {
              tableHtml += '<td>' + renderInlineMarkdown(cell) + '</td>';
            });
            tableHtml += '</tr>';
          });
          tableHtml += '</tbody>';
        }
        tableHtml += '</table>';
        html.push(tableHtml);
        continue;
      }

      if (isUl(line)) {
        var items = [];
        while (i < lines.length && isUl(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
          i++;
        }
        html.push('<ul>' + items.map(function(item) { return '<li>' + renderInlineMarkdown(item) + '</li>'; }).join('') + '</ul>');
        continue;
      }

      if (isOl(line)) {
        var oitems = [];
        while (i < lines.length && isOl(lines[i])) {
          oitems.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
          i++;
        }
        html.push('<ol>' + oitems.map(function(item) { return '<li>' + renderInlineMarkdown(item) + '</li>'; }).join('') + '</ol>');
        continue;
      }

      var paragraph = [line];
      i++;
      while (i < lines.length) {
        var next = lines[i];
        var nextTrimmed = next.trim();
        if (!nextTrimmed) {
          i++;
          break;
        }
        if (
          nextTrimmed.match(/^```/) ||
          nextTrimmed.match(/^(#{1,4})\s+/) ||
          /^---+$/.test(nextTrimmed) ||
          /^\*\*\*+$/.test(nextTrimmed) ||
          isQuote(next) ||
          isUl(next) ||
          isOl(next) ||
          isTableRow(next)
        ) {
          break;
        }
        paragraph.push(next);
        i++;
      }

      html.push('<p>' + renderInlineMarkdown(paragraph.join('\n')).replace(/\n/g, '<br>') + '</p>');
    }

    return html.join('');
  }

  function sanitizeUrl(url) {
    var value = String(url || '').trim();
    if (!value) return '';
    if (/^(https?:|mailto:|tel:|#|\/)/i.test(value)) return value;
    return '';
  }

  function sanitizeHtmlFragment(html) {
    var template = document.createElement('template');
    template.innerHTML = String(html || '');

    var cleanNode = function(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return document.createTextNode(node.textContent || '');
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return document.createDocumentFragment();
      }

      var tag = node.tagName.toLowerCase();
      if (!SAFE_HTML_TAGS.has(tag)) {
        if (['script', 'style', 'iframe', 'object', 'embed'].indexOf(tag) !== -1) {
          return document.createDocumentFragment();
        }

        var fragment = document.createDocumentFragment();
        var children = Array.prototype.slice.call(node.childNodes);
        for (var ci = 0; ci < children.length; ci++) {
          fragment.appendChild(cleanNode(children[ci]));
        }
        return fragment;
      }

      var el = document.createElement(tag);
      var allowedAttrs = SAFE_HTML_ATTRS[tag] || new Set();

      for (var ai = 0; ai < node.attributes.length; ai++) {
        var attr = node.attributes[ai];
        var name = attr.name.toLowerCase();
        if (name.startsWith('on') || name === 'style') continue;
        if (!allowedAttrs.has(name)) continue;

        if (tag === 'a' && name === 'href') {
          var safeHref = sanitizeUrl(attr.value);
          if (!safeHref) continue;
          el.setAttribute('href', safeHref);
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
          continue;
        }

        el.setAttribute(name, attr.value);
      }

      var elChildren = Array.prototype.slice.call(node.childNodes);
      for (var ei = 0; ei < elChildren.length; ei++) {
        el.appendChild(cleanNode(elChildren[ei]));
      }
      return el;
    };

    var wrapperFragment = document.createDocumentFragment();
    var templateChildren = Array.prototype.slice.call(template.content.childNodes);
    for (var ti = 0; ti < templateChildren.length; ti++) {
      wrapperFragment.appendChild(cleanNode(templateChildren[ti]));
    }
    var wrapper = document.createElement('div');
    wrapper.appendChild(wrapperFragment);
    return wrapper.innerHTML;
  }

  function renderAgentHtml(text) {
    var raw = String(text || '');
    if (containsMarkdown(raw)) {
      return sanitizeHtmlFragment(renderMarkdownBlocks(raw));
    }
    if (looksLikeHtmlFragment(raw)) {
      return sanitizeHtmlFragment(raw);
    }
    return sanitizeHtmlFragment(renderMarkdownBlocks(raw));
  }

  function showThinking(label) {
    hideThinking();
    var el = document.createElement('div');
    el.className = 'thinking';
    el.id = 'thinking';
    el.innerHTML =
      '<div class="thinking-dots">' +
        '<div class="dot"></div><div class="dot"></div><div class="dot"></div>' +
      '</div>' +
      '<span class="thinking-label">' + escHtml(String(label || '')) + '</span>';
    var container = document.getElementById('messages') || document.getElementById('chat');
    if (container) container.appendChild(el);
    scrollBottom();
  }

  function hideThinking() {
    var el = document.getElementById('thinking');
    if (el) el.remove();
  }

  function addMessage(role, content, round, isCall, isResult, hiddenThinking) {
    document.getElementById('empty')?.remove();

    var wrap = document.createElement('div');

    if (role === 'user') {
      wrap.className = 'msg user';
      var bubble = document.createElement('div');
      if (containsMarkdown(content)) {
        bubble.className = 'msg-content html-body';
        bubble.innerHTML = renderAgentHtml(content);
      } else {
        bubble.className = 'msg-content';
        bubble.textContent = String(content || '');
      }
      wrap.appendChild(bubble);
    } else if (role === 'agent') {
      wrap.className = 'msg assistant';
      var abubble = document.createElement('div');
      abubble.className = 'msg-content html-body';
      abubble.innerHTML = renderAgentHtml(content);
      wrap.appendChild(abubble);
      if (hiddenThinking && hiddenThinking.length) {
        var details = document.createElement('details');
        details.className = 'thinking-details';
        var summary = document.createElement('summary');
        summary.textContent = 'Thinking (' + hiddenThinking.length + ')';
        details.appendChild(summary);
        var pre = document.createElement('pre');
        pre.className = 'thinking-pre';
        pre.textContent = hiddenThinking.join('\n\n---\n\n');
        details.appendChild(pre);
        wrap.appendChild(details);
      }
    } else {
      var cssRole = role === 'error' ? 'msg-error' : role === 'tool' ? 'msg-tool' : 'msg-system';
      wrap.className = 'msg assistant ' + cssRole;
      var tbubble = document.createElement('div');
      tbubble.className = 'msg-content msg-content-mono';

      var meta = [];
      if (round) meta.push('R' + round);
      if (isCall) meta.push('call');
      if (isResult) meta.push('result');
      meta.push(role);

      var badge = document.createElement('span');
      badge.className = 'msg-meta-badge';
      badge.textContent = meta.join(' \u00b7 ');
      tbubble.appendChild(badge);

      var prettyContent = String(content || '');
      try { var parsed = JSON.parse(prettyContent); prettyContent = JSON.stringify(parsed, null, 2); } catch {}

      var tdetails = document.createElement('details');
      tdetails.className = 'debug-details';
      var tsummary = document.createElement('summary');
      tsummary.className = 'debug-summary';
      var preview = prettyContent.length > 120 ? prettyContent.slice(0, 120).replace(/\n/g, ' ') + '\u2026' : prettyContent.replace(/\n/g, ' ');
      tsummary.textContent = preview;
      tdetails.appendChild(tsummary);
      var tpre = document.createElement('pre');
      tpre.className = 'debug-pre';
      tpre.textContent = prettyContent;
      tdetails.appendChild(tpre);
      tbubble.appendChild(tdetails);

      wrap.appendChild(tbubble);
    }

    var container = document.getElementById('messages') || document.getElementById('chat');
    if (container) container.appendChild(wrap);
    scrollBottom();
  }

  function addNotice(text) {
    var el = document.createElement('div');
    el.className = 'ctx-notice';
    el.textContent = text;
    var container = document.getElementById('messages') || document.getElementById('chat');
    if (container) container.appendChild(el);
    scrollBottom();
  }

  function setStatus(state, label) {
    var topbarStatus = document.getElementById('topbar-status');
    if (topbarStatus) topbarStatus.textContent = label;
    var badge = document.getElementById('badge-status');
    if (badge) badge.textContent = label;
    var dot = document.getElementById('badge-status-dot');
    if (dot) dot.innerHTML = '<span class="status-dot ' + state + '"></span>&nbsp;' + label;
  }

  function updateStats() {
    var rounds = document.getElementById('stat-rounds');
    if (rounds) rounds.textContent = window.sessionStats ? window.sessionStats.rounds : 0;
    var tools = document.getElementById('stat-tools');
    if (tools) tools.textContent = window.sessionStats ? window.sessionStats.tools : 0;
    var resets = document.getElementById('stat-resets');
    if (resets) resets.textContent = window.sessionStats ? window.sessionStats.resets : 0;
    var msgs = document.getElementById('stat-msgs');
    if (msgs) msgs.textContent = window.sessionStats ? window.sessionStats.msgs : 0;
  }

  function scrollBottom() {
    var chat = document.getElementById('chat');
    if (chat) chat.scrollTop = chat.scrollHeight;
  }

  function updateCtxBar() {
    var Comp = window.AgentCompaction;
    var size = Comp && Comp.ctxSize ? Comp.ctxSize(window.messages) : (Array.isArray(window.messages) ? window.messages.reduce(function(n, m) { return n + (m.content || '').length; }, 0) : 0);
    var limitEl = document.getElementById('sl-ctx');
    var limit = limitEl ? parseInt(limitEl.value, 10) * 1000 : 32000;
    var pct = Math.min(100, (size / limit) * 100);
    var bar = document.getElementById('ctx-bar');
    var label = document.getElementById('ctx-pct');
    if (bar) {
      bar.style.width = pct + '%';
      bar.classList.toggle('warn', pct > 60 && pct <= 85);
      bar.classList.toggle('danger', pct > 85);
    }
    if (label) label.textContent = pct.toFixed(1) + '%';
  }

  function notifyIfHidden(summary) {
    if (document.visibilityState === 'visible') return;
    if (!('Notification' in window)) return;
    if (window.Notification.permission !== 'granted') return;

    try {
      var C = window.CONSTANTS || {};
      new window.Notification('JS Agent', {
        body: String(summary || 'Task complete.').slice(0, (C.NOTIFICATION_BODY_MAX_CHARS || 200)),
        tag: 'agent-run-finished',
        silent: false
      });
    } catch (error) {
      console.warn('Notification failed:', error && error.message ? error.message : error);
    }
  }

  function updateBadge() {
    var badgeRounds = document.getElementById('badge-rounds');
    var slRounds = document.getElementById('sl-rounds');
    if (badgeRounds && slRounds) {
      badgeRounds.textContent = 'rounds ' + slRounds.value;
    }

    var badgeCtx = document.getElementById('badge-ctx');
    var slCtx = document.getElementById('sl-ctx');
    if (badgeCtx && slCtx) {
      badgeCtx.textContent = 'context ' + slCtx.value + 'k';
    }
  }

  function shouldAutoCollapseSidebar() {
    return window.innerWidth <= (window.CONSTANTS && window.AgentConstants && window.AgentConstants.SIDEBAR_AUTO_COLLAPSE_WIDTH ? window.AgentConstants.SIDEBAR_AUTO_COLLAPSE_WIDTH : 1180);
  }

  function syncSidebarToggleButtons() {
    var collapsed = document.body.classList.contains('sidebar-collapsed');
    var openBtn = document.getElementById('sidebar-open-btn');
    var collapseBtn = document.getElementById('sidebar-collapse-btn');
    var openLabel = collapsed ? 'Show sidebar' : 'Hide sidebar';
    var openIcon = collapsed ? '\u2630' : '\u2190';

    if (openBtn) {
      openBtn.textContent = openIcon;
      openBtn.title = openLabel;
      openBtn.setAttribute('aria-label', openLabel);
      openBtn.setAttribute('aria-expanded', String(!collapsed));
    }

    if (collapseBtn) {
      collapseBtn.textContent = '\u2190';
      collapseBtn.title = 'Hide sidebar';
      collapseBtn.setAttribute('aria-label', 'Hide sidebar');
      collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    }
  }

  function applySidebarState() {
    var SIDEBAR_COLLAPSED_KEY = 'agent_sidebar_collapsed_v1';
    var stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    var collapsed = stored == null ? shouldAutoCollapseSidebar() : stored === 'true';
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    syncSidebarToggleButtons();
  }

  function toggleSidebar() {
    var SIDEBAR_COLLAPSED_KEY = 'agent_sidebar_collapsed_v1';
    var next = !document.body.classList.contains('sidebar-collapsed');
    document.body.classList.toggle('sidebar-collapsed', next);
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
    syncSidebarToggleButtons();
  }

  function handleResponsiveSidebar() {
    var SIDEBAR_COLLAPSED_KEY = 'agent_sidebar_collapsed_v1';
    if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) == null) {
      applySidebarState();
    }
    syncSidebarToggleButtons();
  }

  function updateActiveProviderBadge() {
    var badge = document.getElementById('topbar-model');
    if (!badge) return;

    if (window.localBackend && window.localBackend.enabled) {
      var model = String(document.getElementById('local-model-select') ? document.getElementById('local-model-select').value : (window.localBackend.model || '')).trim();
      badge.textContent = 'local/' + (model || 'unknown');
      return;
    }

    if (typeof window.ollamaBackend !== 'undefined' && window.ollamaBackend && window.ollamaBackend.enabled) {
      var omodel = '';
      if (typeof getOllamaCloudModel === 'function') omodel = getOllamaCloudModel().trim();
      if (!omodel) {
        badge.textContent = 'ollama';
        return;
      }
      var route = (typeof isSelectedOllamaModelCloud === 'function' && isSelectedOllamaModelCloud()) ? 'cloud' : 'local';
      badge.textContent = 'ollama-' + route + '/' + omodel;
      return;
    }

    badge.textContent = typeof getSelectedCloudModelLabel === 'function' ? getSelectedCloudModelLabel() : '';
  }

  function maybeRequestNotifPermission() {
    var NOTIF_KEY = '_agent_notif_requested';
    if (sessionStorage.getItem(NOTIF_KEY)) return;
    if (!('Notification' in window)) return;
    if (window.Notification.permission !== 'default') return;

    sessionStorage.setItem(NOTIF_KEY, '1');
    window.Notification.requestPermission().then(function(permission) {
      if (permission === 'granted') {
        if (typeof addNotice === 'function') addNotice('Notifications enabled.');
      }
    }).catch(function() {
      sessionStorage.removeItem(NOTIF_KEY);
    });
  }

  function renderSessionList() {
    if (typeof window.chatSessions === 'undefined') return;
    var host = document.getElementById('session-list');
    if (!host) return;

    host.innerHTML = Array.isArray(window.chatSessions) && window.chatSessions.length
      ? window.chatSessions.map(function(session) {
          return '<div class="session-item ' + (session.id === window.activeSessionId ? 'active' : '') + '" onclick="activateSession(\'' + session.id + '\')">' +
            '<span class="session-title">' + escHtml(session.title) + '</span>' +
            '<button class="delete-btn" onclick="event.stopPropagation();deleteSession(\'' + session.id + '\')" title="Delete">\u00d7</button>' +
          '</div>';
        }).join('')
      : '<div class="session-empty">No conversations yet</div>';
  }

  function renderChatFromMessages() {
    var container = document.getElementById('messages');
    var chat = document.getElementById('chat');

    if (container) container.innerHTML = '';

    var existingEmpty = document.getElementById('empty');
    if (!Array.isArray(window.messages) || !window.messages.length) {
      if (!existingEmpty && chat) {
        var emptyEl = document.createElement('div');
        emptyEl.className = 'empty-state';
        emptyEl.id = 'empty';
        emptyEl.innerHTML =
          '<div class="empty-logo">\u2b21</div>' +
          '<div class="empty-title">What can I help you with?</div>' +
          '<div class="empty-examples">' +
            '<button class="example-chip" onclick="useExample(this)">Search web for latest news</button>' +
            '<button class="example-chip" onclick="useExample(this)">Calculate interest on $10k savings</button>' +
            '<button class="example-chip" onclick="useExample(this)">Tell me today\'s date & time</button>' +
            '<button class="example-chip" onclick="useExample(this)">Help with file operations</button>' +
          '</div>';
        chat.insertBefore(emptyEl, container || null);
      }
      return;
    }

    if (existingEmpty) existingEmpty.remove();

    for (var i = 0; i < window.messages.length; i++) {
      var message = window.messages[i];
      if (message.role === 'system') continue;

      if (message.role === 'assistant') {
        var parsed = typeof splitModelReply === 'function' ? splitModelReply(message.content) : { visible: message.content, thinkingBlocks: [] };
        addMessage('agent', parsed.visible, null, false, false, parsed.thinkingBlocks);
        continue;
      }

      addMessage(message.role, message.content, null);
    }
  }

  window.AgentUIRender = {
    escHtml: escHtml,
    containsMarkdown: containsMarkdown,
    looksLikeHtmlFragment: looksLikeHtmlFragment,
    escapeInlineHtml: escapeInlineHtml,
    renderInlineMarkdown: renderInlineMarkdown,
    renderMarkdownBlocks: renderMarkdownBlocks,
    sanitizeUrl: sanitizeUrl,
    sanitizeHtmlFragment: sanitizeHtmlFragment,
    renderAgentHtml: renderAgentHtml,
    showThinking: showThinking,
    hideThinking: hideThinking,
    addMessage: addMessage,
    addNotice: addNotice,
    setStatus: setStatus,
    updateStats: updateStats,
    scrollBottom: scrollBottom,
    updateCtxBar: updateCtxBar,
    notifyIfHidden: notifyIfHidden,
    updateBadge: updateBadge,
    shouldAutoCollapseSidebar: shouldAutoCollapseSidebar,
    syncSidebarToggleButtons: syncSidebarToggleButtons,
    applySidebarState: applySidebarState,
    toggleSidebar: toggleSidebar,
    handleResponsiveSidebar: handleResponsiveSidebar,
    updateActiveProviderBadge: updateActiveProviderBadge,
    maybeRequestNotifPermission: maybeRequestNotifPermission,
    renderSessionList: renderSessionList,
    renderChatFromMessages: renderChatFromMessages
  };

  window.escHtml = escHtml;
  window.addMessage = addMessage;
  window.addNotice = addNotice;
  window.setStatus = setStatus;
  window.updateStats = updateStats;
  window.scrollBottom = scrollBottom;
  window.updateCtxBar = updateCtxBar;
  window.notifyIfHidden = notifyIfHidden;
  window.updateBadge = updateBadge;
  window.shouldAutoCollapseSidebar = shouldAutoCollapseSidebar;
  window.syncSidebarToggleButtons = syncSidebarToggleButtons;
  window.applySidebarState = applySidebarState;
  window.toggleSidebar = toggleSidebar;
  window.handleResponsiveSidebar = handleResponsiveSidebar;
  window.updateActiveProviderBadge = updateActiveProviderBadge;
  window.maybeRequestNotifPermission = maybeRequestNotifPermission;
  window.renderSessionList = renderSessionList;
  window.renderChatFromMessages = renderChatFromMessages;
  window.renderAgentHtml = renderAgentHtml;
  window.renderMarkdownBlocks = renderMarkdownBlocks;
  window.renderInlineMarkdown = renderInlineMarkdown;
  window.sanitizeHtmlFragment = sanitizeHtmlFragment;
  window.sanitizeUrl = sanitizeUrl;
  window.containsMarkdown = containsMarkdown;
  window.looksLikeHtmlFragment = looksLikeHtmlFragment;
  window.showThinking = showThinking;
  window.hideThinking = hideThinking;
})();