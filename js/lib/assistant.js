import { h } from './ui.js';
import { drawer } from './drawer.js';

export function initAssistant({ api, recordMicrophone = null, browserDemo = false, getConfig, getCapabilities, onRefresh, openConnections }) {
  const view = drawer('assistant', 'Assistant', browserDemo ? 'Ask about the sample workspace or add a task in this browser.' : 'Ask about your workspace, make a plan, or add a task.');
  const provider = h('span', { class: 'assistant-provider' });
  const status = h('p', { class: 'assistant-status', role: 'status', 'aria-live': 'polite' }, 'Ready');
  const log = h('div', { class: 'conversation', role: 'log', 'aria-label': 'Assistant conversation', 'aria-live': 'polite' });
  const welcome = h('div', { class: 'assistant-welcome' }, h('h3', {}, 'A little less context switching.'), h('p', {}, 'Local commands work without a model. Try a workspace summary or add a task to your checklist.'));
  const input = h('textarea', { id: 'assistant-message', rows: 3, maxlength: 4000, placeholder: 'What needs your attention?', 'aria-label': 'Message to assistant' });
  const form = h('form', { class: 'assistant-form' });
  const send = h('button', { type: 'submit', class: 'primary-button' }, 'Send');
  const record = h('button', { type: 'button', class: 'secondary-button' }, 'Record');
  const stop = h('button', { type: 'button', class: 'secondary-button', disabled: true }, 'Stop');
  const playReply = h('button', { type: 'button', class: 'secondary-button', hidden: true }, 'Play reply');
  const voiceNote = h('p', { class: 'field-help', role: 'status', 'aria-live': 'polite' });
  const prompts = h('div', { class: 'prompt-buttons' }, ...['Give me a workspace summary', 'Show my tasks', 'Add a task: review the release checklist'].map(text => h('button', { type: 'button', class: 'prompt-button', onclick: () => { input.value = text; input.focus(); } }, text)));
  welcome.append(prompts); log.append(welcome);
  form.append(h('label', { for: 'assistant-message', class: 'microlabel' }, 'Your request'), input, h('div', { class: 'assistant-controls' }, record, stop, send), voiceNote, playReply);
  view.content.append(h('div', { class: 'assistant-meta' }, provider, h('button', { type: 'button', class: 'text-button', onclick: () => { view.dialog.close(); openConnections(); } }, 'Settings')), status, log, form);
  let busy = false, cancelling = false, controller = null, recorder = null, preparingMic = false, requestId = 0, speaking = false, activeUtterance = null, speechNotice = '';
  let speechController = null, speechAudio = null, speechUrl = null, speechId = 0, voiceSettings = null, playbackBlocked = false;
  const outputProvider = () => browserDemo ? 'system' : getConfig().voice?.outputProvider || 'system';
  const settingsKey = () => {
    const config = getConfig(), voice = config.voice || {};
    return JSON.stringify([!!voice.enabled, outputProvider(), config.mode, voice.elevenlabsVoiceId, voice.elevenlabsModel, voice.hasElevenlabsApiKey]);
  };
  const releaseAudio = () => {
    if (speechAudio) {
      speechAudio.onended = null; speechAudio.onerror = null;
      speechAudio.pause(); speechAudio.removeAttribute('src'); speechAudio.load(); speechAudio = null;
    }
    if (speechUrl) { URL.revokeObjectURL(speechUrl); speechUrl = null; }
    playbackBlocked = false;
  };
  const stopSpeech = () => {
    ++speechId;
    if (speechController || speechAudio) speechNotice = '';
    speechController?.abort(); speechController = null; releaseAudio();
    activeUtterance = null;
    window.webkit?.messageHandlers?.yunusSpeech?.postMessage({ cancel: true });
    window.speechSynthesis?.cancel(); speaking = false;
  };
  const sync = () => {
    const config = getConfig(), capabilities = getCapabilities();
    const currentSettings = settingsKey();
    if (voiceSettings !== null && voiceSettings !== currentSettings) { stopSpeech(); speechNotice = ''; }
    voiceSettings = currentSettings;
    playReply.hidden = !playbackBlocked;
    playReply.disabled = busy || cancelling || speaking;
    const names = { local: 'Local commands', ollama: 'Ollama', claude: 'Claude CLI' };
    provider.textContent = browserDemo ? 'Demo commands · no model' : names[config.assistant?.provider] || 'Local commands';
    const enabled = !!config.voice?.enabled, available = capabilities.voice?.available !== false;
    if (!enabled) speechNotice = '';
    record.hidden = !enabled || !recordMicrophone;
    record.disabled = busy || cancelling || preparingMic || (!recorder && !available);
    record.textContent = recorder ? 'Finish recording' : preparingMic ? 'Opening microphone…' : 'Record';
    record.classList.toggle('recording', !!recorder);
    send.disabled = busy || cancelling || !!recorder || preparingMic;
    stop.disabled = cancelling || (!busy && !recorder && !speaking && !preparingMic && !speechAudio && !speechController);
    const speechHelp = outputProvider() === 'elevenlabs'
      ? capabilities.speech?.available === false ? `ElevenLabs spoken replies: ${capabilities.speech.reason || 'Check Connections to finish setup.'}` : 'Spoken replies use ElevenLabs.'
      : 'Spoken replies use an available local system voice.';
    const microphoneHelp = available ? 'Record up to 30 seconds. Review the transcript before sending.' : `Microphone input is unavailable. ${capabilities.voice?.reason || 'Local transcription needs Whisper and a model. Check Connections.'}`;
    voiceNote.textContent = speechNotice || (browserDemo ? (enabled ? 'Replies use an installed local browser voice, if available. Microphone input is available in the local app.' : 'Read-aloud is off. You can enable it in About this demo. Microphone input is available in the local app.') : !enabled ? 'Voice is off. Enable it in Connections whenever you want.' : `${speechHelp} ${microphoneHelp}`);
  };
  const addMessage = (role, text) => {
    if (welcome.isConnected) welcome.remove();
    const entry = h('article', { class: `message ${role}` }, h('div', { class: 'message-author' }, role === 'user' ? 'You' : 'Assistant'), h('div', { class: 'message-text' }, text));
    log.append(entry); entry.scrollIntoView({ block: 'nearest', behavior: 'auto' }); return entry;
  };
  const playAudio = async ownId => {
    const audio = speechAudio;
    if (!audio || ownId !== speechId) return;
    playbackBlocked = false; speaking = true; speechNotice = 'Playing your ElevenLabs spoken reply…'; sync();
    if (ownId !== speechId || speechAudio !== audio) return;
    try { await audio.play(); }
    catch (error) {
      if (ownId !== speechId || speechAudio !== audio) return;
      speaking = false;
      if (error.name === 'NotAllowedError') {
        playbackBlocked = true; speechNotice = 'Your ElevenLabs reply is ready. Press Play reply to hear it.';
      } else {
        releaseAudio(); speechNotice = 'The ElevenLabs audio could not be played. Your written reply is still available.';
      }
      sync();
    }
  };
  playReply.addEventListener('click', () => {
    if (!playbackBlocked || busy || cancelling || speaking) return;
    void playAudio(speechId);
  });
  const sayWithElevenLabs = async text => {
    const capability = getCapabilities().speech;
    if (getConfig().mode !== 'live' || capability?.available === false) {
      speechNotice = capability?.reason || 'ElevenLabs speech needs My workspace mode and a connection in Settings. Your written reply is still available.'; sync(); return;
    }
    const ownId = speechId, selectedSettings = settingsKey();
    speechController = new AbortController(); speaking = true;
    speechNotice = 'Generating your spoken reply with ElevenLabs…'; sync();
    let generated = false;
    try {
      const blob = await api('/api/speech', { method: 'POST', body: { text }, signal: speechController.signal, responseType: 'blob' });
      if (ownId !== speechId) return;
      if (selectedSettings !== settingsKey()) { sync(); return; }
      speechController = null; generated = true;
      speechUrl = URL.createObjectURL(blob); speechAudio = new Audio(speechUrl);
      const audio = speechAudio;
      audio.onended = () => {
        if (ownId !== speechId || speechAudio !== audio) return;
        releaseAudio(); speaking = false; speechNotice = 'ElevenLabs spoken reply finished.'; sync();
      };
      audio.onerror = () => {
        if (ownId !== speechId || speechAudio !== audio) return;
        releaseAudio(); speaking = false; speechNotice = 'The ElevenLabs audio could not be played. Your written reply is still available.'; sync();
      };
      await playAudio(ownId);
    } catch (error) {
      if (ownId !== speechId) return;
      if (selectedSettings !== settingsKey()) { sync(); return; }
      speechController = null; releaseAudio(); speaking = false;
      const reason = typeof error?.message === 'string' ? ` ${error.message.slice(0, 300)}` : '';
      speechNotice = generated ? 'The ElevenLabs audio could not be played. Your written reply is still available.' : `ElevenLabs could not generate the spoken reply.${reason} Your written reply is still available.`; sync();
    }
  };
  const say = text => {
    if (!getConfig().voice?.enabled) return;
    speechNotice = ''; stopSpeech();
    if (outputProvider() === 'elevenlabs') { void sayWithElevenLabs(text); return; }
    const failed = () => { activeUtterance = null; speaking = false; speechNotice = 'The browser could not play the spoken reply. Your reply is shown above. You can try again.'; sync(); };
    const native = window.webkit?.messageHandlers?.yunusSpeech;
    if (native) { native.postMessage({ text }); speaking = true; sync(); return; }
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      speechNotice = 'Spoken replies are not supported in this browser. Your reply is shown above.'; sync(); return;
    }
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      const voices = speechSynthesis.getVoices(), localVoice = voices.find(voice => voice.localService && voice.lang.startsWith(navigator.language.split('-')[0])) || voices.find(voice => voice.localService);
      if (!localVoice) { speechNotice = 'No local browser voice is available. Your reply is shown above.'; sync(); return; }
      utterance.voice = localVoice; utterance.rate = 1;
      utterance.onend = () => { if (activeUtterance !== utterance) return; activeUtterance = null; speaking = false; sync(); };
      utterance.onerror = event => {
        if (activeUtterance !== utterance) return;
        if (event.error === 'canceled' || event.error === 'interrupted') { activeUtterance = null; speaking = false; sync(); }
        else failed();
      };
      activeUtterance = utterance; speaking = true; speechSynthesis.speak(utterance); sync();
    } catch { failed(); }
  };
  async function finishRecording() {
    if (!recorder) return;
    const captured = recorder; recorder = null; busy = true; status.textContent = 'Transcribing on this computer…'; sync();
    const ownId = ++requestId; controller = new AbortController();
    try {
      const wav = await captured.stop();
      if (ownId !== requestId || !wav) return;
      const result = await api('/api/transcribe', { method: 'POST', binary: true, body: wav, signal: controller.signal });
      if (ownId !== requestId) return;
      input.value = result.text || ''; status.textContent = input.value ? 'Transcript ready. Review it, then press Send.' : 'No speech detected. You can try again or type a request.'; input.focus();
    } catch (error) { if (ownId === requestId) status.textContent = error.name === 'AbortError' ? 'Stopped' : error.message; }
    finally { if (ownId === requestId) { busy = false; controller = null; sync(); } }
  }
  record.addEventListener('click', async () => {
    if (recorder) { await finishRecording(); return; }
    if (busy || cancelling || preparingMic || !recordMicrophone || !getConfig().voice?.enabled) return;
    stopSpeech(); preparingMic = true; const ownId = ++requestId; status.textContent = 'Allow microphone access to start recording.'; sync();
    try {
      const session = await recordMicrophone(() => { void finishRecording(); });
      if (ownId !== requestId) { await session.stop({ discard: true }); return; }
      recorder = session; status.textContent = 'Listening. Press Finish recording when you are done.';
    } catch (error) { if (ownId === requestId) status.textContent = error.name === 'NotAllowedError' ? 'Microphone permission was denied. Enable it in your browser, or type your request.' : error.message; }
    finally { if (ownId === requestId) { preparingMic = false; sync(); } }
  });
  const cancel = async () => {
    if (cancelling) return;
    cancelling = true;
    ++requestId; controller?.abort(); controller = null; stopSpeech();
    const captured = recorder; recorder = null; busy = false; preparingMic = false; status.textContent = 'Stopping…'; sync();
    let cleanupFailed = false, cancellationFailed = false;
    try {
      try { await captured?.stop({ discard: true }); } catch { cleanupFailed = true; }
      try { await api('/api/assistant/cancel', { method: 'POST', body: {} }); } catch { cancellationFailed = true; }
    } finally {
      cancelling = false;
      status.textContent = cancellationFailed ? 'Stopped locally. Could not confirm server cancellation. You can try again.' : cleanupFailed ? 'Stopped. The microphone did not close cleanly. You can try recording again.' : 'Stopped';
      sync();
    }
  };
  stop.addEventListener('click', () => { void cancel(); });
  view.dialog.addEventListener('close', () => { if (recorder || busy || preparingMic || speaking || speechAudio || speechController) void cancel(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); const message = input.value.trim(); if (!message || busy || cancelling || recorder || preparingMic) return;
    busy = true; stopSpeech(); const ownId = ++requestId; controller = new AbortController(); sync();
    addMessage('user', message); input.value = ''; status.textContent = 'Working…';
    try {
      const response = await api('/api/assistant', { method: 'POST', body: { message }, signal: controller.signal });
      if (ownId !== requestId) return;
      const text = String(response.text || 'No response returned. Try a different request.');
      const entry = addMessage('assistant', text);
      if (Array.isArray(response.actions) && response.actions.length) {
        const actions = h('div', { class: 'action-approvals' }, h('p', {}, browserDemo ? 'Review before saving in this browser:' : 'Review before running on this computer:'));
        for (const action of response.actions.slice(0, 5)) {
          const description = String(action.label || action.description || (action.type === 'add_task' ? `Add task: ${action.title}` : null) || action.app || action.url || action.type || 'Proposed action').slice(0, 250);
          const button = h('button', { type: 'button', class: 'secondary-button' }, `Approve: ${description}`);
          button.addEventListener('click', async () => {
            button.disabled = true;
            try { const result = await api('/api/action', { method: 'POST', body: { action } }); button.textContent = result.message || 'Action completed'; await onRefresh(); }
            catch (error) { button.textContent = `Try again: ${description}`; button.disabled = false; status.textContent = error.message; }
          });
          actions.append(button);
        }
        entry.append(actions);
      }
      status.textContent = 'Ready'; say(text); await onRefresh();
    } catch (error) { if (ownId === requestId) status.textContent = error.name === 'AbortError' ? 'Stopped' : error.message; }
    finally { if (ownId === requestId) { busy = false; controller = null; sync(); input.focus(); } }
  });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); form.requestSubmit(); } });
  return { open() { sync(); view.open(); input.focus(); }, sync };
}
