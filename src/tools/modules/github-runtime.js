// src/tools/modules/github-runtime.js
// GitHub REST API tool: search code, PRs, issues, file contents.
// Requires a GitHub token stored in window.githubToken or localStorage('github_token').
// Publishes: window.AgentToolModules.createGithubRuntime

(() => {
  'use strict';

  window.AgentToolModules = window.AgentToolModules || {};

  window.AgentToolModules.createGithubRuntime = function createGithubRuntime({ formatToolResult }) {
    const GITHUB_API = 'https://api.github.com';

    function getToken() {
      return window.githubToken
        || String(localStorage.getItem('github_token') || '').trim();
    }

    async function githubFetch(path, init = {}) {
      const token = getToken();
      const headers = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'JS-Agent/1.0',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(init.headers || {})
      };
      const res = await fetch(`${GITHUB_API}${path}`, { ...init, headers });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`GitHub API ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }

    async function githubSearchCode({ query, repo, language, per_page = 10 } = {}) {
      if (!String(query || '').trim()) throw new Error('query is required');
      let q = String(query).trim();
      if (repo) q += ` repo:${repo}`;
      if (language) q += ` language:${language}`;
      const data = await githubFetch(`/search/code?q=${encodeURIComponent(q)}&per_page=${Math.min(50, Number(per_page) || 10)}`);
      const items = (data.items || []).map(item =>
        `${item.repository.full_name}/${item.path}\n  ${item.html_url}`
      );
      return formatToolResult('github_search_code',
        items.length ? `Found ${data.total_count} results (showing ${items.length}):\n\n${items.join('\n')}` : 'No results found.');
    }

    async function githubGetPr({ repo, pr_number } = {}) {
      if (!repo || !pr_number) throw new Error('repo and pr_number are required');
      const [pr, files] = await Promise.all([
        githubFetch(`/repos/${repo}/pulls/${pr_number}`),
        githubFetch(`/repos/${repo}/pulls/${pr_number}/files`)
      ]);
      const fileList = (files || []).map(f => `  ${f.status.padEnd(9)} ${f.filename} (+${f.additions}/-${f.deletions})`).join('\n');
      const body = [
        `PR #${pr.number}: ${pr.title}`,
        `State: ${pr.state} | Author: ${pr.user?.login} | Mergeable: ${pr.mergeable ?? 'unknown'}`,
        `Branch: ${pr.head?.ref} → ${pr.base?.ref}`,
        `URL: ${pr.html_url}`,
        '',
        pr.body ? pr.body.slice(0, 1000) : '(no description)',
        '',
        `Files changed (${files?.length || 0}):`,
        fileList
      ].join('\n');
      return formatToolResult('github_get_pr', body);
    }

    async function githubListPrs({ repo, state = 'open', per_page = 10 } = {}) {
      if (!String(repo || '').trim()) throw new Error('repo is required');
      const data = await githubFetch(`/repos/${repo}/pulls?state=${state}&per_page=${Math.min(50, Number(per_page) || 10)}&sort=updated&direction=desc`);
      const items = (data || []).map(pr =>
        `#${pr.number} ${pr.title}\n  Author: ${pr.user?.login} | Updated: ${pr.updated_at?.slice(0, 10)} | ${pr.html_url}`
      );
      return formatToolResult('github_list_prs',
        items.length ? items.join('\n\n') : 'No pull requests found.');
    }

    async function githubCreateIssue({ repo, title, body: issueBody, labels } = {}) {
      if (!repo || !String(title || '').trim()) throw new Error('repo and title are required');
      const token = getToken();
      if (!token) throw new Error('GitHub token required to create issues');
      const data = await githubFetch(`/repos/${repo}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: String(title).trim(),
          body: String(issueBody || ''),
          labels: Array.isArray(labels) ? labels : (labels ? [labels] : [])
        })
      });
      return formatToolResult('github_create_issue',
        `Created issue #${data.number}: ${data.title}\n${data.html_url}`);
    }

    async function githubGetFile({ repo, path, ref = 'main' } = {}) {
      if (!repo || !String(path || '').trim()) throw new Error('repo and path are required');
      const data = await githubFetch(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
      if (data.type !== 'file') throw new Error(`${path} is not a file (type: ${data.type})`);
      const content = atob(String(data.content || '').replace(/\s/g, ''));
      return formatToolResult('github_get_file',
        `File: ${repo}/${path} @ ${ref} (${data.size} bytes)\n\n${content.slice(0, 20000)}`);
    }

    async function githubListIssues({ repo, state = 'open', labels, per_page = 10 } = {}) {
      if (!String(repo || '').trim()) throw new Error('repo is required');
      let url = `/repos/${repo}/issues?state=${state}&per_page=${Math.min(50, Number(per_page) || 10)}&sort=updated&direction=desc`;
      if (labels) url += `&labels=${encodeURIComponent(String(labels))}`;
      const data = await githubFetch(url);
      const items = (data || []).filter(i => !i.pull_request).map(i =>
        `#${i.number} ${i.title}\n  Author: ${i.user?.login} | Updated: ${i.updated_at?.slice(0, 10)} | ${i.html_url}`
      );
      return formatToolResult('github_list_issues',
        items.length ? items.join('\n\n') : 'No issues found.');
    }

    return {
      githubSearchCode,
      githubGetPr,
      githubListPrs,
      githubCreateIssue,
      githubGetFile,
      githubListIssues
    };
  };
})();
