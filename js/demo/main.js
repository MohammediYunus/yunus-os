import { startApp } from '../app.js';
import { createDemoApi } from './api.js';
import { initDemoSettings } from './settings.js';

let storage = null;
try { storage = window.localStorage; } catch { /* The demo also works for this tab only. */ }
const { api, connectSession } = createDemoApi({ storage });
startApp({ api, connectSession, browserDemo: true, createConnections: options => initDemoSettings({ ...options, api }) });
