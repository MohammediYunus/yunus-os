import { h } from './ui.js';
import { api } from './api.js';
import { drawer } from './drawer.js';

function field(label, name, { type = 'text', help, placeholder = '', options, multiline = false } = {}) {
  const input = options ? h('select', { name, id: `setting-${name}` }, options.map(([value, text]) => h('option', { value }, text)))
    : h(multiline ? 'textarea' : 'input', { name, id: `setting-${name}`, ...(multiline ? { rows: 3 } : { type }), placeholder, autocomplete: type === 'password' ? 'new-password' : 'off', spellcheck: 'false' });
  const wrapper = h('div', { class: 'setting-field' }, h('label', { for: input.id }, label), input, help ? h('p', { class: 'field-help', id: `${input.id}-help` }, help) : null);
  if (help) input.setAttribute('aria-describedby', `${input.id}-help`);
  return { input, wrapper };
}
const lines = text => text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

export function initConnections({ getConfig, onSaved }) {
  const view = drawer('connections', 'Connections', 'Your workspace. Your accounts. Saved on this computer.');
  const form = h('form', { class: 'settings-form' });
  const fields = {};
  const add = (container, label, name, options) => { const item = field(label, name, options); fields[name] = item.input; container.append(item.wrapper); };
  const workspace = h('fieldset', {}, h('legend', {}, 'Workspace'));
  add(workspace, 'Workspace name', 'displayName', { placeholder: 'My workspace' });
  add(workspace, 'Show', 'mode', { options: [['demo', 'Demo workspace'], ['live', 'My workspace']] });
  add(workspace, 'Repository folders', 'workspacePaths', { multiline: true, placeholder: '/path/to/your/repository', help: 'One absolute folder path per line. Only selected folders are scanned. Leave empty to start with local tasks.' });
  add(workspace, 'Time zone', 'timezone', { placeholder: 'system', help: 'Use system for your local clock, or an IANA zone such as Europe/London.' });
  const github = h('fieldset', {}, h('legend', {}, 'GitHub'));
  add(github, 'GitHub username', 'githubUsername', { placeholder: 'your-username' });
  add(github, 'Repositories', 'githubRepositories', { multiline: true, placeholder: 'owner/repository', help: 'One owner/repository per line. Reads pull requests and checks; does not write to GitHub.' });
  add(github, 'Token', 'githubToken', { type: 'password', placeholder: 'Leave blank to keep existing token', help: 'Optional for public data. Stored by the local server; never sent back to this page.' });
  const tokenStatus = h('p', { class: 'field-help' });
  const clearToken = h('input', { type: 'checkbox', name: 'clearToken', id: 'clear-token' });
  github.append(tokenStatus, h('label', { class: 'check-row', for: 'clear-token' }, clearToken, 'Remove saved GitHub token'));
  const assistant = h('fieldset', {}, h('legend', {}, 'Assistant'));
  add(assistant, 'Provider', 'provider', { options: [['local', 'Local workspace commands'], ['ollama', 'Ollama'], ['claude', 'Claude CLI']] });
  const providerNote = h('p', { class: 'field-help provider-note' }); assistant.append(providerNote);
  const ollamaFields = h('div');
  add(ollamaFields, 'Ollama endpoint', 'endpoint', { placeholder: 'http://127.0.0.1:11434' });
  add(ollamaFields, 'Model', 'model', { placeholder: 'An installed model name', help: 'Install models yourself. Yunus OS does not download a model for you.' });
  const claudeFields = h('div');
  add(claudeFields, 'Claude executable', 'executable', { placeholder: 'claude', help: 'Executable name or absolute path. Uses your existing CLI setup when you send a message.' });
  assistant.append(ollamaFields, claudeFields);
  const voice = h('fieldset', {}, h('legend', {}, 'Voice'));
  const voiceEnabled = h('input', { type: 'checkbox', id: 'voice-enabled' });
  voice.append(h('label', { class: 'check-row', for: 'voice-enabled' }, voiceEnabled, 'Enable microphone controls and spoken replies'), h('p', { class: 'field-help' }, 'Optional. Microphone access is requested only when you press Record. Spoken replies use macOS speech in the native app, or an installed local browser voice.'));
  add(voice, 'Whisper executable', 'whisperExecutable', { placeholder: 'whisper-cli' });
  add(voice, 'Whisper model file', 'whisperModelPath', { placeholder: '/path/to/ggml-model.bin', help: 'An existing local whisper.cpp model for transcription. No audio is sent to a cloud transcription service.' });
  const status = h('p', { class: 'form-status', role: 'status', 'aria-live': 'polite' });
  const save = h('button', { type: 'submit', class: 'primary-button' }, 'Save connections');
  const capability = h('div', { class: 'capability-note' });
  form.append(workspace, github, assistant, voice, capability, h('div', { class: 'drawer-actions' }, status, save));
  view.content.append(form);
  function providerChanged() {
    const provider = fields.provider.value;
    ollamaFields.hidden = provider !== 'ollama'; claudeFields.hidden = provider !== 'claude';
    providerNote.textContent = provider === 'local' ? 'Works immediately for workspace summaries and task commands. No language model or account required.' : provider === 'ollama' ? 'Sends your messages to your configured local Ollama server when requested.' : 'Sends your messages through your installed Claude CLI when requested. Your existing plan or API billing applies.';
  }
  fields.provider.addEventListener('change', providerChanged);
  const hydrate = () => {
    const config = getConfig();
    fields.displayName.value = config.displayName || 'My workspace'; fields.mode.value = config.mode || 'demo';
    fields.timezone.value = config.timezone || 'system'; fields.workspacePaths.value = (config.workspacePaths || []).join('\n');
    fields.githubUsername.value = config.github?.username || ''; fields.githubRepositories.value = (config.github?.repositories || []).join('\n'); fields.githubToken.value = ''; clearToken.checked = false;
    tokenStatus.textContent = config.github?.hasToken ? 'A GitHub token is saved.' : 'No GitHub token saved.';
    fields.provider.value = config.assistant?.provider || 'local'; fields.endpoint.value = config.assistant?.endpoint || 'http://127.0.0.1:11434'; fields.model.value = config.assistant?.model || ''; fields.executable.value = config.assistant?.executable || 'claude';
    voiceEnabled.checked = !!config.voice?.enabled; fields.whisperExecutable.value = config.voice?.whisperExecutable || 'whisper-cli'; fields.whisperModelPath.value = config.voice?.whisperModelPath || '';
    capability.textContent = 'Connections stay local. Optional providers run only when you ask. Computer actions require a separate confirmation in Assistant.';
    status.textContent = ''; status.classList.remove('error'); providerChanged();
  };
  form.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true; status.classList.remove('error'); status.textContent = 'Saving and checking your workspace…';
    const github = { username: fields.githubUsername.value.trim(), repositories: lines(fields.githubRepositories.value) };
    if (clearToken.checked) github.clearToken = true;
    else if (fields.githubToken.value.trim()) github.token = fields.githubToken.value.trim();
    try {
      await api('/api/config', { method: 'POST', body: { displayName: fields.displayName.value.trim(), mode: fields.mode.value, timezone: fields.timezone.value.trim() || 'system', workspacePaths: lines(fields.workspacePaths.value), github, assistant: { provider: fields.provider.value, model: fields.model.value.trim(), endpoint: fields.endpoint.value.trim(), executable: fields.executable.value.trim() }, voice: { enabled: voiceEnabled.checked, whisperExecutable: fields.whisperExecutable.value.trim(), whisperModelPath: fields.whisperModelPath.value.trim() } } });
      fields.githubToken.value = ''; clearToken.checked = false;
      await onSaved(); status.textContent = 'Connections saved. You can close this panel.';
      tokenStatus.textContent = getConfig().github?.hasToken ? 'A GitHub token is saved.' : 'No GitHub token saved.';
    } catch (error) { status.textContent = error.message; status.classList.add('error'); }
    finally { fields.githubToken.value = ''; save.disabled = false; }
  });
  return { open() { hydrate(); view.open(); } };
}
