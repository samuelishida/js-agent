// src/tools/core/intents.js
// Intent detection: currencies, weather, filesystem, generation, etc.

(() => {
  /** @type {Object} */
  const root = (window.AgentToolCore = window.AgentToolCore || {});

  /**
   * Extract entities from text.
   * @param {string} text - Input text
   * @returns {{urls: string[], currencies: string[]}} Extracted entities
   */
  function extractEntities(text) {
    const input = String(text || '');
    return {
      urls: [...input.matchAll(/https?:\/\/[^\s]+/gi)].map(match => match[0]),
      currencies: [...input.matchAll(/\b(usd|dolar|d[oÃ³]lar|brl|real|reais|eur|euro|gbp|libra|jpy|iene)\b/gi)].map(match => match[1].toLowerCase())
    };
  }

  /**
   * Normalize a currency token.
   * @param {string} token - Currency token
   * @returns {string|null} Normalized currency or null
   */
  function normalizeCurrencyToken(token) {
    const aliases = {
      usd: 'USD',
      dolar: 'USD',
      'dÃ³lar': 'USD',
      brl: 'BRL',
      real: 'BRL',
      reais: 'BRL',
      eur: 'EUR',
      euro: 'EUR',
      gbp: 'GBP',
      libra: 'GBP',
      jpy: 'JPY',
      iene: 'JPY'
    };

    return aliases[String(token || '').toLowerCase()] || null;
  }

  /**
   * Detect FX pair from text.
   * @param {string} text - Input text
   * @returns {{base: string, quote: string}|null} FX pair or null
   */
  function detectFxPair(text) {
    const currencies = extractEntities(text).currencies.map(normalizeCurrencyToken).filter(Boolean);
    const unique = [...new Set(currencies)];

    if (unique.length >= 2) return { base: unique[0], quote: unique[1] };
    if (unique.length === 1 && (unique[0] === 'USD' || unique[0] === 'BRL')) return { base: 'USD', quote: 'BRL' };
    if (/\bcota[cÃ§][aÃ£]o\b/i.test(text) && /\b(dolar|d[oÃ³]lar|usd)\b/i.test(text) && /\b(real|reais|brl)\b/i.test(text)) {
      return { base: 'USD', quote: 'BRL' };
    }

    return null;
  }

  /**
   * Detect weather intent.
   * @param {string} text - Input text
   * @returns {boolean} True if weather intent
   */
  function detectWeatherIntent(text) {
    const value = String(text || '').toLowerCase();
    return /(weather|temperature|temperatura|clima|forecast|previs[aÃ£]o|how hot|how cold)/i.test(value);
  }

  /**
   * Detect filesystem intent.
   * @param {string} text - Input text
   * @returns {boolean} True if filesystem intent
   */
  function detectFilesystemIntent(text) {    // Don't match if this is a generation request (DOCX, PDF, etc.)
    if (detectGenerationIntent(text)) return false;    return /(file|files|arquivo|arquivos|folder|pasta|directory|diret[oÃ³]rio|rename|renome|move|mover|copy|copiar|delete|deletar|remove|remover|list files|listar arquivos|search file|buscar arquivo|open file|abrir arquivo|read project|ler projeto|leia o projeto|leio o proejto|codebase|repo|repository|src\/|[a-z]:\\)/i.test(String(text || ''));
  }

  /**
   * Detect authorize folder intent.
   * @param {string} text - Input text
   * @returns {boolean} True if authorize intent
   */
  function detectAuthorizeFolderIntent(text) {
    return /(authorize folder|autorizar pasta|authorize|autoriz[aá]r|permiss[aã]o|directory access|acesso [àa] pasta)/i.test(String(text || ''));
  }

  /**
   * Detect full file display intent.
   * @param {string} text - Input text
   * @returns {boolean} True if display intent
   */
  function detectFullFileDisplayIntent(text) {
    const value = String(text || '');
    return /(show|mostre|mostrar|exiba|print|imprima|cat|dump|full|complete|completo|inteiro).*(readme|README|arquivo|file)|((readme|README).*(full|complete|completo|inteiro))/i.test(value);
  }

  /**
   * Detect project tools intent.
   * @param {string} text - Input text
   * @returns {boolean} True if project tools intent
   */
  function detectProjectToolsIntent(text) {
    const value = String(text || '');
    if (/(agentic loop|agent loop|orchestrator|tool loop|runtime loop|max_rounds|context manager|execution loop)/i.test(value)) {
      return true;
    }

    return /(explain|explique|skills|habilidades|capabilities|capacidades).*(project|projeto|repo|codebase)|((project|projeto|repo|codebase).*(skills|habilidades|capabilities))/i.test(value);
  }

  /**
   * Detect save intent.
   * @param {string} text - Input text
   * @returns {boolean} True if save intent
   */
  function detectSaveIntent(text) {
    return /(save|salvar|write file|escrever arquivo|export|exportar|download|baixar|save it|save as|json file|arquivo json)/i.test(String(text || ''));
  }

  /**
   * Detect file generation intent.
   * @param {string} text - Input text
   * @returns {boolean} True if generation intent
   */
  function detectGenerationIntent(text) {
    const value = String(text || '').toLowerCase();
    // Binary file generation keywords
    if (/\b(generate|create|make|build|produce|gerar|criar|fazer|produzir|convert).*(docx|doc|pdf|xlsx|xls|pptx|ppt|png|jpg|image|report|relat[oó]rio|spreadsheet|planilha|presentation|apresenta[cç][aã]o)\b/i.test(value)) return true;
    if (/\b(docx|pdf|xlsx|pptx)\b/i.test(value) && /\b(generate|create|make|build|produce|export|download|gerar|criar|fazer|with|com)\b/i.test(value)) return true;
    // Direct format requests: "a docx", "an xlsx", etc.
    if (/\b(a\s+|an\s+)?(docx|pdf|xlsx|pptx)\b/i.test(value) && /\b(generate|create|make|build|export|download|report|relat)\b/i.test(value)) return true;
    return false;
  }

  /**
   * Detect clipboard intent.
   * @param {string} text - Input text
   * @returns {boolean} True if clipboard intent
   */
  function detectClipboardIntent(text) {
    return /(clipboard|area de transferencia|Ã¡rea de transferÃªncia|copiar texto|paste|colar)/i.test(String(text || ''));
  }

  /**
   * Detect parsing intent.
   * @param {string} text - Input text
   * @returns {boolean} True if parsing intent
   */
  function detectParsingIntent(text) {
    return /(json|csv|parse|validar json|parsear csv|extract links|extrair links|metadata)/i.test(String(text || ''));
  }

  /**
   * Detect tab coordination intent.
   * @param {string} text - Input text
   * @returns {boolean} True if tab coordination intent
   */
  function detectTabCoordinationIntent(text) {
    return /(other tab|another tab|open tab|other window|another window|dashboard|share|send to other tab|manda pra outra aba|outra aba|outra janela|espera a outra aba|broadcast|all tabs|todas as abas)/i.test(String(text || ''));
  }

  /**
   * Detect recency intent.
   * @param {string} text - Input text
   * @returns {boolean} True if recency intent
   */
  function detectRecencyIntent(text) {
    return /(recent|recente|latest|last\s+(hour|day|week|month|year)|today|hoje|agora|atual|atualizado|news|noticia|noticias|ultim[ao]s?|202[4-9]|2030)/i.test(String(text || ''));
  }

  function detectCodingIntent(text) {
    return /(github|repo|repository|source code|javascript|typescript|python|java|rust|go|node|npm|package|library|framework|api sdk|open source)/i.test(String(text || ''));
  }

  function detectBiographicalFactIntent(text) {
    return /(when|quando|date|data|born|nasc|died|morreu|faleceu|death|obito|biography|biografia|idade|age)/i.test(String(text || ''));
  }

  root.intents = {
    extractEntities,
    detectFxPair,
    detectWeatherIntent,
    detectFilesystemIntent,
    detectAuthorizeFolderIntent,
    detectFullFileDisplayIntent,
    detectProjectToolsIntent,
    detectSaveIntent,
    detectGenerationIntent,
    detectClipboardIntent,
    detectParsingIntent,
    detectTabCoordinationIntent,
    detectRecencyIntent,
    detectCodingIntent,
    detectBiographicalFactIntent
  };
})();
