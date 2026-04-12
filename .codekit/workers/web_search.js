const https = require('https');

function searchGoogleNewsRss(terms) {
    const url = 'https://r.jina.ai/http://news.google.com/rss/search?q=' + encodeURIComponent(terms) + '&hl=pt-BR&gl=BR&ceid=BR:pt-419';

    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch (e) {
                        resolve(data);
                    }
                } else {
                    reject(new Error('Failed to fetch Google News RSS'));
                }
            });
        }).on('error', reject);
    });
}

function searchWikipedia(terms, language) {
    const baseUrl = language === 'pt' ? 
        'http://pt.wikipedia.org/wiki/' : 
        'http://en.wikipedia.org/wiki/';
    
    const url = 'https://r.jina.ai/' + baseUrl + encodeURIComponent(terms);
    
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch (e) {
                        resolve(data);
                    }
                } else {
                    reject(new Error('Failed to fetch Wikipedia'));
                }
            });
        }).on('error', reject);
    });
}

function searchDuckDuckGo(terms) {
    const url = 'https://r.jina.ai/http://duckduckgo.com/html/?q=' + encodeURIComponent(terms);
    
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch (e) {
                        resolve(data);
                    }
                } else {
                    reject(new Error('Failed to fetch DuckDuckGo'));
                }
            });
        }).on('error', reject);
    });
}

function searchReddit(terms) {
    const url = 'https://r.jina.ai/http://www.reddit.com/search'? + 
        '&q=' + encodeURIComponent(terms) + '&' + 
        'restrict_search=off&sort=relevance&type=search';
    
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch (e) {
                        resolve(data);
                    }
                } else {
                    reject(new Error('Failed to fetch Reddit'));
                }
            });
        }).on('error', reject);
    });
}

function searchBing(terms) {
    const url = 'https://r.jina.ai/http://www.bing.com/search'? + 
        '&q=' + encodeURIComponent(terms);
    
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch (e) {
                        resolve(data);
                    }
                } else {
                    reject(new Error('Failed to fetch Bing'));
                }
            });
        }).on('error', reject);
    });
}

function searchYahoo(terms) {
    const url = 'https://r.jina.ai/http://search.yahoo.com/search'? +
        '&p=' + encodeURIComponent(terms);
    
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch (e) {
                        resolve(data);
                    }
                } else {
                    reject(new Error('Failed to fetch Yahoo'));
                }
            });
        }).on('error', reject);
    });
}

function searchGoogle(terms) {
    const url = 'https://r.jina.ai/http://www.google.com/search'? +
        '&q=' + encodeURIComponent(terms);
    
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch (e) {
                        resolve(data);
                    }
                } else {
                    reject(new Error('Failed to fetch Google'));
                }
            });
        }).on('error', reject);
    });
}

function searchBaidu(terms) {
    const url = 'https://r.jina.ai/http://www.baidu.com/s'? +
        '&wd=' + encodeURIComponent(terms);
    
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch (e) {
                        resolve(data);
                    }
                } else {
                    reject(new Error('Failed to fetch Baidu'));
                }
            });
        }).on('error', reject);
    });
}

function searchYandex(terms) {
    const url = 'https://r.jina.ai/http://yandex.com/search'? +
        '&text=' + encodeURIComponent(terms);
    
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch (e) {
                        resolve(data);
                    }
                } else {
                    reject(new Error('Failed to fetch Yandex'));
                }
            });
        }).on('error', reject);
    });
}

function searchEcosia(terms) {
    const url = 'https://r.jina.ai/http://www.ecosia.org/search'? +
        '&q=' + encodeURIComponent(terms);
    
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch (e) {
                        resolve(data);
                    }
                } else {
                    reject(new Error('Failed to fetch Ecosia'));
                }
            });
        }).on('error', reject);
    });
}

module.exports = {
    searchGoogle,
    searchGoogleNewsRss,
    searchWikipedia,
    searchDuckDuckGo,
    searchReddit,
    searchBing,
    searchYahoo,
    searchBaidu,
    searchYandex,
    searchEcosia
};
