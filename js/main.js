import { startApp } from './app.js';
import { api, connectSession } from './lib/api.js';
import { initConnections } from './lib/connections.js';
import { recordMicrophone } from './lib/microphone.js';

startApp({ api, connectSession, createConnections: initConnections, recordMicrophone });
