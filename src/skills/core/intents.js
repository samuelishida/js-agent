(() => {
  const root = (window.AgentSkillCore = window.AgentSkillCore || {});

  function extractEntities(text) {
    const input = String(text || '');
    return {
      urls: [...input.matchAll(/https?:\/\/[^\s]+/gi)].map(match => match[0]),
      currencies: [...input.matchAll(/\b(usd|dolar|d[oÃ³]lar|brl|real|reais|eur|euro|gbp|libra|jpy|iene)\b/gi)].map(match => match[1].toLowerCase())
    };
  }

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

  function detectWeatherIntent(text) {
    const value = String(text || '').toLowerCase();
    return /(weather|temperature|temperatura|clima|forecast|previs[aÃ£]o|how hot|how cold)/i.test(value);
  }

  function detectFilesystemIntent(text) {
    return /(file|files|arquivo|arquivos|folder|pasta|directory|diret[oÃ³]rio|rename|renome|move|mover|copy|copiar|delete|deletar|remove|remover|list files|listar arquivos|search file|buscar arquivo|open file|abrir arquivo|read project|ler projeto|leia o projeto|leio o proejto|codebase|repo|repository|src\/|[a-z]:\\)/i.test(String(text || ''));
  }

  function detectAuthorizeFolderIntent(text) {
    return /(authorize folder|autorizar pasta|authorize|autoriz[aá]r|permiss[aã]o|directory access|acesso [àa] pasta)/i.test(String(text || ''));
  }

  function detectFullFileDisplayIntent(text) {
    const value = String(text || '');
    return /(show|mostre|mostrar|exiba|print|imprima|cat|dump|full|complete|completo|inteiro).*(readme|README|arquivo|file)|((readme|README).*(full|complete|completo|inteiro))/i.test(value);
  }

  function detectProjectSkillsIntent(text) {
    const value = String(text || '');
    if (/(agentic loop|agent loop|orchestrator|tool loop|runtime loop|max_rounds|context manager|execution loop)/i.test(value)) {
      return true;
    }

    return /(explain|explique|skills|habilidades|capabilities|capacidades).*(project|projeto|repo|codebase)|((project|projeto|repo|codebase).*(skills|habilidades|capabilities))/i.test(value);
  }

  function detectSaveIntent(text) {
    return /(save|salvar|write file|escrever arquivo|export|exportar|download|baixar|save it|save as|json file|arquivo json)/i.test(String(text || ''));
  }

  function detectClipboardIntent(text) {
    return /(clipboard|area de transferencia|Ã¡rea de transferÃªncia|copiar texto|paste|colar)/i.test(String(text || ''));
  }

  function detectParsingIntent(text) {
    return /(json|csv|parse|validar json|parsear csv|extract links|extrair links|metadata)/i.test(String(text || ''));
  }

  function detectTabCoordinationIntent(text) {
    return /(other tab|another tab|open tab|other window|another window|dashboard|share|send to other tab|manda pra outra aba|outra aba|outra janela|espera a outra aba|broadcast|all tabs|todas as abas)/i.test(String(text || ''));
  }

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
    detectProjectSkillsIntent,
    detectSaveIntent,
    detectClipboardIntent,
    detectParsingIntent,
    detectTabCoordinationIntent,
    detectRecencyIntent,
    detectCodingIntent,
    detectBiographicalFactIntent
  };
})();
