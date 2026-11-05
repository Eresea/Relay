const tokenInput = document.querySelector('#token');
const error = document.querySelector('#error');
const library = document.querySelector('#library');
const list = document.querySelector('#list');
let token = sessionStorage.getItem('artifacts-token') || '';
let artifacts = [];
async function api(options = {}) {
  const response = await fetch('/api/artifacts', {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
function render() {
  const query = document.querySelector('#search').value.toLowerCase();
  list.replaceChildren();
  for (const item of artifacts.filter((item) => item.name.toLowerCase().includes(query))) {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.href = `/a/${item.id}`;
    link.textContent = item.name;
    li.append(link);
    list.append(li);
  }
}
async function refresh() {
  artifacts = await api();
  render();
  library.hidden = false;
  document.querySelector('#login').hidden = true;
  sessionStorage.setItem('artifacts-token', token);
  error.textContent = '';
}
async function upload(file) {
  try {
    if (!file || !/\.html?$/i.test(file.name)) throw new Error('Choose an HTML file.');
    if (file.size > 1500000) throw new Error('File must be under 1.5 MB.');
    await api({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name.replace(/\.html?$/i, ''), html: await file.text() }),
    });
    await refresh();
  } catch (e) {
    error.textContent = e.message;
  }
}
document.querySelector('#login').addEventListener('submit', async (event) => {
  event.preventDefault();
  token = tokenInput.value;
  try {
    await refresh();
    tokenInput.value = '';
  } catch (e) {
    error.textContent = e.message;
  }
});
document.querySelector('#lock').addEventListener('click', () => {
  token = '';
  sessionStorage.removeItem('artifacts-token');
  library.hidden = true;
  document.querySelector('#login').hidden = false;
});
document.querySelector('#search').addEventListener('input', render);
document.querySelector('#file').addEventListener('change', (event) => {
  void upload(event.target.files[0]);
  event.target.value = '';
});
const drop = document.querySelector('#drop');
drop.addEventListener('dragover', (event) => event.preventDefault());
drop.addEventListener('drop', (event) => {
  event.preventDefault();
  void upload(event.dataTransfer.files[0]);
});
if (token)
  refresh().catch(() => {
    token = '';
    sessionStorage.removeItem('artifacts-token');
  });
