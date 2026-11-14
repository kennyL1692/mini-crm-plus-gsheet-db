// Talks to the Apps Script Web App using the server-to-server API key.
// The same Apps Script rules apply as for the website (validation, edit-clash
// check, delete = move to the "Deleted" tab).

export function createCrm({ url, apiKey, actor = 'mcp', fetchImpl = fetch, timeoutMs = 25000 }) {
  if (!url || !apiKey) {
    const missing = [!url && 'APPS_SCRIPT_URL', !apiKey && 'APPS_SCRIPT_API_KEY'].filter(Boolean).join(' and ');
    const fail = async () => { throw new Error(`MCP server is not set up yet: add ${missing} in Netlify environment variables.`); };
    return { list: fail, create: fail, update: fail, remove: fail };
  }

  async function call(action, payload = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        // text/plain keeps Apps Script happy; it follows a redirect to the real answer.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action, api_key: apiKey, actor }, payload)),
        redirect: 'follow',
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new Error(err.name === 'AbortError' ? 'Google Sheet took too long to answer. Please try again.' : 'Could not reach the Google Sheet (Apps Script).');
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('Apps Script sent a reply that is not JSON. Check APPS_SCRIPT_URL ends in /exec and the deployment has access "Anyone".');
    }
    if (!json.ok) {
      if (json.code === 'AUTH') throw new Error('The Sheet rejected the API key. Check API_KEY in the Settings tab matches APPS_SCRIPT_API_KEY on Netlify.');
      throw new Error(json.error || 'The Sheet returned an error.');
    }
    return json.data;
  }

  return {
    list: () => call('list'),
    create: (contact) => call('create', { contact }),
    update: (contact) => call('update', { contact }),
    remove: (id) => call('delete', { id }),
  };
}
