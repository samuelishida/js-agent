(() => {
  window.AgentSkillModules = window.AgentSkillModules || {};

  window.AgentSkillModules.createDataRuntime = function createDataRuntime({
    formatToolResult,
    TODOS_STORAGE_KEY,
    TASKS_STORAGE_KEY
  }) {
    async function parseJsonText({ text }) {
      const value = JSON.parse(String(text || ''));
      return formatToolResult('parse_json', JSON.stringify(value, null, 2).slice(0, 12000));
    }

    async function parseCsvText({ text }) {
      const rows = String(text || '')
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => line.split(',').map(cell => cell.trim()));

      if (!rows.length) {
        throw new Error('CSV input is empty.');
      }

      const preview = rows.slice(0, 10).map(row => row.join(' | ')).join('\n');
      return formatToolResult('parse_csv', `Rows: ${rows.length}\nColumns: ${rows[0].length}\n\n${preview}`);
    }

    async function clipboardRead() {
      if (!navigator.clipboard?.readText) {
        throw new Error('Clipboard read is not supported in this browser.');
      }

      const text = await navigator.clipboard.readText();
      return formatToolResult('clipboard_read', text || '(clipboard empty)');
    }

    async function clipboardWrite({ text }) {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard write is not supported in this browser.');
      }

      await navigator.clipboard.writeText(String(text || ''));
      return formatToolResult('clipboard_write', 'Clipboard updated.');
    }

    async function listStorageKeys() {
      const lines = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        lines.push(key);
      }

      return formatToolResult('storage_list_keys', lines.join('\n') || '(no localStorage keys)');
    }

    async function storageGet({ key }) {
      return formatToolResult('storage_get', `${key} = ${localStorage.getItem(String(key))}`);
    }

    async function storageSet({ key, value }) {
      localStorage.setItem(String(key), String(value ?? ''));
      return formatToolResult('storage_set', `Saved ${key}`);
    }

    function loadTodos() {
      try {
        const stored = JSON.parse(localStorage.getItem(TODOS_STORAGE_KEY) || '[]');
        return Array.isArray(stored) ? stored : [];
      } catch {
        return [];
      }
    }

    function saveTodos(todos) {
      localStorage.setItem(TODOS_STORAGE_KEY, JSON.stringify(todos));
    }

    async function todoWrite({ items, text, todos }) {
      const now = new Date().toISOString();
      let normalizedItems = [];

      const sourceItems = Array.isArray(todos) ? todos : items;

      if (Array.isArray(sourceItems)) {
        normalizedItems = sourceItems
          .map(item => {
            if (typeof item === 'string') {
              return { id: '', text: item.trim(), status: 'pending', priority: 'medium' };
            }

            const value = item && typeof item === 'object' ? item : null;
            const itemText = String(value?.text || value?.title || value?.content || '').trim();
            const status = String(value?.status || 'pending').trim() || 'pending';
            const priority = String(value?.priority || 'medium').trim() || 'medium';
            if (!itemText) return null;
            return {
              id: String(value?.id || '').trim(),
              text: itemText,
              status,
              priority
            };
          })
          .filter(Boolean);
      } else {
        const lines = String(text || '')
          .split(/\r?\n/)
          .map(line => line.replace(/^\s*[-*\d.\[\]xX]+\s*/, '').trim())
          .filter(Boolean);
        normalizedItems = lines.map(line => ({ id: '', text: line, status: 'pending', priority: 'medium' }));
      }

      if (!normalizedItems.length) {
        throw new Error('todo_write requires non-empty items or text.');
      }

      const next = normalizedItems.map((item, index) => ({
        id: item.id || `todo_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`,
        text: item.text,
        status: item.status,
        priority: item.priority || 'medium',
        createdAt: now,
        updatedAt: now
      }));

      saveTodos(next);

      return formatToolResult(
        'todo_write',
        `Saved ${next.length} todo item(s).\n\n${next.map((item, index) => `${index + 1}. [${item.status}] ${item.text}${item.priority ? ` (priority: ${item.priority})` : ''}`).join('\n')}`
      );
    }

    function loadTasks() {
      try {
        const stored = JSON.parse(localStorage.getItem(TASKS_STORAGE_KEY) || '[]');
        return Array.isArray(stored) ? stored : [];
      } catch {
        return [];
      }
    }

    function saveTasks(tasks) {
      localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(tasks));
    }

    function normalizeTaskStatus(status) {
      const value = String(status || 'todo').toLowerCase().trim();
      if (['todo', 'in_progress', 'done', 'blocked'].includes(value)) return value;
      return 'todo';
    }

    async function taskCreate(args = {}) {
      const title = String(args.title || '').trim();
      if (!title) throw new Error('task_create requires title.');

      const tasks = loadTasks();
      const now = new Date().toISOString();
      const task = {
        id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        title,
        description: String(args.description || '').trim(),
        status: normalizeTaskStatus(args.status),
        createdAt: now,
        updatedAt: now
      };

      tasks.unshift(task);
      saveTasks(tasks);
      return formatToolResult('task_create', JSON.stringify(task, null, 2));
    }

    async function taskGet({ id }) {
      const taskId = String(id || '').trim();
      if (!taskId) throw new Error('task_get requires id.');
      const task = loadTasks().find(item => item.id === taskId);
      if (!task) throw new Error(`task_get: task not found (${taskId}).`);
      return formatToolResult('task_get', JSON.stringify(task, null, 2));
    }

    async function taskList({ status, limit = 50 } = {}) {
      const max = Math.max(1, Math.min(500, Number(limit) || 50));
      const wanted = String(status || '').trim().toLowerCase();
      const tasks = loadTasks()
        .filter(item => !wanted || String(item.status || '').toLowerCase() === wanted)
        .slice(0, max);

      return formatToolResult(
        'task_list',
        tasks.length
          ? tasks.map((item, index) => `${index + 1}. ${item.id} | [${item.status}] ${item.title}`).join('\n')
          : '(no tasks)'
      );
    }

    async function taskUpdate(args = {}) {
      const taskId = String(args.id || '').trim();
      if (!taskId) throw new Error('task_update requires id.');

      const tasks = loadTasks();
      const index = tasks.findIndex(item => item.id === taskId);
      if (index < 0) throw new Error(`task_update: task not found (${taskId}).`);

      const current = tasks[index];
      const next = {
        ...current,
        ...(args.title !== undefined ? { title: String(args.title || '').trim() } : {}),
        ...(args.description !== undefined ? { description: String(args.description || '').trim() } : {}),
        ...(args.status !== undefined ? { status: normalizeTaskStatus(args.status) } : {}),
        updatedAt: new Date().toISOString()
      };

      tasks[index] = next;
      saveTasks(tasks);
      return formatToolResult('task_update', JSON.stringify(next, null, 2));
    }

    async function askUserQuestion({ question, options }) {
      const prompt = String(question || '').trim();
      if (!prompt) throw new Error('ask_user_question requires question.');
      const optionList = Array.isArray(options) ? options.map(item => `- ${String(item)}`).join('\n') : '';

      return formatToolResult(
        'ask_user_question',
        `Question for user:\n${prompt}${optionList ? `\n\nOptions:\n${optionList}` : ''}\n\nRuntime note: direct interactive prompt tool is not available in this browser runtime. Ask the user in chat and continue after they reply.`
      );
    }

    return {
      parseJsonText,
      parseCsvText,
      clipboardRead,
      clipboardWrite,
      listStorageKeys,
      storageGet,
      storageSet,
      todoWrite,
      taskCreate,
      taskGet,
      taskList,
      taskUpdate,
      askUserQuestion
    };
  };
})();
