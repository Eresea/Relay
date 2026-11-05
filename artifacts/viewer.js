const id = location.pathname.split('/').pop();
const frame = document.querySelector('#artifact');
const api = `/api/artifacts/${id}`;
const bootstrap = `<script>
(() => {
  let next = 0; const pending = new Map();
  window.addEventListener('message', event => {
    if (event.source !== parent || !event.data || event.data.type !== 'relay-result') return;
    const promise = pending.get(event.data.id); if (!promise) return;
    pending.delete(event.data.id); event.data.error ? promise.reject(new Error(event.data.error)) : promise.resolve(event.data.value);
  });
  function call(action, key, value) {
    return new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); parent.postMessage({ type: 'relay-data', id, action, key, value }, '*'); });
  }
  window.relay = Object.freeze({ data: Object.freeze({ get: key => call('get', key), set: (key, value) => call('set', key, value), delete: key => call('delete', key) }) });
})();<\/script>`;
window.addEventListener('message', async (event) => {
  if (event.source !== frame.contentWindow || !event.data || event.data.type !== 'relay-data')
    return;
  const { id, action, key, value } = event.data;
  try {
    const response = await fetch(`${api}/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, key, value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    frame.contentWindow.postMessage({ type: 'relay-result', id, value: result.value }, '*');
  } catch (error) {
    frame.contentWindow.postMessage({ type: 'relay-result', id, error: error.message }, '*');
  }
});
fetch(api)
  .then(async (response) => {
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    document.title = result.name;
    frame.title = result.name;
    frame.srcdoc = bootstrap + result.html;
  })
  .catch((error) => {
    document.querySelector('#error').textContent = error.message;
  });
