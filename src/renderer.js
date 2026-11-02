const WebSocket = require('ws');
const os = require('os');
const { ipcRenderer, clipboard } = require('electron');

// ---------- Elementos ----------
const $ = (id) => document.getElementById(id);
const setupScreen = $('setup-screen');
const callScreen = $('call-screen');
const statusBadge = $('connection-status');
const stage = $('stage');
const stageLabel = $('stage-label');
const noVideoText = $('no-video-text');
const remoteVideo = $('remote-video');
const localVideo = $('local-video');
const remoteVoice = $('remote-voice');
const micSelect = $('mic-select');
const speakerSelect = $('speaker-select');
const btnHost = $('btn-host');
const btnConnect = $('btn-connect');
const btnMic = $('btn-mic');
const btnScreen = $('btn-screen');
const btnFullscreen = $('btn-fullscreen');
const btnEnd = $('btn-end');
const volumeSlider = $('volume');
const targetIpInput = $('target-ip');
const myIpBox = $('my-ip-box');
const picker = $('picker');
const pickerGrid = $('picker-grid');
const pickerConfirm = $('picker-confirm');
const pickerCancel = $('picker-cancel');
const optAudio = $('opt-audio');
const optQuality = $('opt-quality');
const toastEl = $('toast');

// ---------- Estado ----------
const WS_PORT = 8080;
// Dentro da VPN os IPs são diretos: não precisa de STUN (só atrasaria a conexão)
const rtcConfig = { iceServers: [] };

const QUALITY = {
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 6_000_000 },
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 10_000_000 },
  '720p30':  { width: 1280, height: 720,  fps: 30, bitrate: 3_000_000 }
};

let wss = null;
let ws = null;
let pc = null;
let localStream = null;      // microfone
let micSender = null;
let screenStream = null;     // tela que EU transmito
let screenSenders = [];
let remoteScreenId = null;   // id do stream de tela do amigo (informado por sinalização)
let isHost = false;
let isMicMuted = false;
let ending = false;
let currentQuality = QUALITY['1080p30'];
let swapped = false;         // quando os dois transmitem: false = amigo no centro, true = eu no centro
let selectedSourceId = null;
let disconnectTimer = null;

// Estado da "negociação perfeita" (evita conflito quando os dois lados renegociam)
let makingOffer = false;
let ignoreOffer = false;
let polite = false;
let messageQueue = Promise.resolve();

// ---------- Utilidades ----------
function toast(text, type = 'error', ms = 4000) {
  toastEl.textContent = text;
  toastEl.className = type === 'info' ? 'info' : '';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.add('hidden'), ms);
}

function updateStatus(text, state) {
  statusBadge.innerText = text;
  statusBadge.className = 'status' + (state ? ' ' + state : '');
}

function switchToCallScreen() {
  setupScreen.style.display = 'none';
  callScreen.style.display = 'flex';
}

function switchToSetupScreen() {
  setupScreen.style.display = 'flex';
  callScreen.style.display = 'none';
}

// ---------- IP da Radmin (para mostrar ao anfitrião) ----------
function detectRadminIps() {
  const found = [];
  const others = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      (a.address.startsWith('26.') ? found : others).push({ name, ip: a.address });
    }
  }
  return { found, others };
}

function showMyIp() {
  const { found, others } = detectRadminIps();
  if (found.length) {
    myIpBox.innerHTML = `Seu IP da Radmin: <strong>${found[0].ip}</strong><small>Clique para copiar e enviar ao amigo</small>`;
    myIpBox.onclick = () => { clipboard.writeText(found[0].ip); toast('IP copiado!', 'info', 1500); };
  } else {
    myIpBox.innerHTML = `IP da Radmin não detectado<small>Abra a Radmin VPN e entre na rede${others.length ? ` (outros IPs: ${others.map(o => o.ip).join(', ')})` : ''}</small>`;
    myIpBox.onclick = null;
  }
}
showMyIp();

// ---------- Dispositivos de áudio ----------
async function loadAudioDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const savedMic = localStorage.getItem('micId');
  const savedSpk = localStorage.getItem('speakerId');
  const activeMic = localStream?.getAudioTracks()[0]?.getSettings().deviceId;

  micSelect.innerHTML = '';
  speakerSelect.innerHTML = '';
  let micCount = 1, spkCount = 1;

  devices.forEach(d => {
    if (d.kind === 'audioinput') {
      micSelect.add(new Option(d.label || `Microfone ${micCount++}`, d.deviceId));
    } else if (d.kind === 'audiooutput') {
      speakerSelect.add(new Option(d.label || `Saída de áudio ${spkCount++}`, d.deviceId));
    }
  });

  // Alguns sistemas não listam saídas: garante ao menos o padrão
  if (!speakerSelect.options.length) speakerSelect.add(new Option('Saída padrão do sistema', 'default'));
  if (!micSelect.options.length) micSelect.add(new Option('Microfone padrão', 'default'));

  // Mostra o microfone realmente em uso (ou o último escolhido)
  const micValue = [activeMic, savedMic].find(v => v && [...micSelect.options].some(o => o.value === v));
  if (micValue) micSelect.value = micValue;
  if (savedSpk && [...speakerSelect.options].some(o => o.value === savedSpk)) speakerSelect.value = savedSpk;

  await applySpeaker();
}

async function applySpeaker() {
  const id = speakerSelect.value;
  if (!id) return;
  for (const el of [remoteVoice, remoteVideo]) {
    try {
      if (typeof el.setSinkId === 'function') await el.setSinkId(id);
    } catch (err) {
      console.error('Erro ao alterar saída de áudio', err);
      toast('Não foi possível usar essa saída de áudio.');
    }
  }
}

navigator.mediaDevices.addEventListener('devicechange', () => {
  // Fones plugados/desplugados: atualiza as listas mantendo a seleção
  loadAudioDevices().catch(console.error);
});

speakerSelect.addEventListener('change', () => {
  localStorage.setItem('speakerId', speakerSelect.value);
  applySpeaker();
});

micSelect.addEventListener('change', async () => {
  localStorage.setItem('micId', micSelect.value);
  if (!localStream) return; // na tela inicial só guarda a preferência; o mic abre ao iniciar a chamada
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(micSelect.value) });
    const newTrack = newStream.getAudioTracks()[0];
    newTrack.enabled = !isMicMuted;

    if (micSender) await micSender.replaceTrack(newTrack);
    localStream?.getAudioTracks().forEach(t => t.stop());
    localStream = newStream;
  } catch (err) {
    console.error(err);
    toast('Não foi possível usar esse microfone.');
  }
});

function micConstraints(deviceId) {
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };
}

volumeSlider.addEventListener('input', () => {
  const v = volumeSlider.value / 100;
  remoteVoice.volume = v;
  remoteVideo.volume = v;
});

// ---------- Início da chamada ----------
async function initLocalMedia() {
  try {
    const saved = localStorage.getItem('micId');
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(saved) });
    } catch {
      // Microfone salvo não existe mais: usa o padrão
      localStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(null) });
    }
    await loadAudioDevices();
    return true;
  } catch (e) {
    toast('Erro ao acessar o microfone: ' + e.message);
    return false;
  }
}

function resetCallUi() {
  isMicMuted = false;
  btnMic.innerText = 'Desativar Mic';
  btnMic.className = 'btn-primary';
  btnScreen.innerText = 'Compartilhar Tela';
  btnScreen.className = 'btn-secondary';
  remoteVideo.srcObject = null;
  localVideo.srcObject = null;
  remoteVoice.srcObject = null;
  swapped = false;
  updateStage();
}

btnHost.addEventListener('click', async () => {
  if (!(await initLocalMedia())) return;
  isHost = true;
  polite = false;
  resetCallUi();
  switchToCallScreen();
  startSignalingServer();
});

btnConnect.addEventListener('click', async () => {
  const ip = targetIpInput.value.trim();
  if (!ip) return toast('Insira o IP da Radmin VPN do anfitrião.');
  localStorage.setItem('lastIp', ip);
  if (!(await initLocalMedia())) return;
  isHost = false;
  polite = true;
  resetCallUi();
  switchToCallScreen();
  connectToSignalingServer(ip);
});

targetIpInput.value = localStorage.getItem('lastIp') || '';
targetIpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnConnect.click(); });

// ---------- Sinalização (WebSocket pela VPN) ----------
function startSignalingServer() {
  ending = false;
  const { found } = detectRadminIps();
  noVideoText.textContent = found.length
    ? `Aguardando seu amigo conectar em ${found[0].ip}...`
    : 'Aguardando seu amigo conectar...';
  updateStatus('Aguardando conexão...', 'waiting');

  wss = new WebSocket.Server({ port: WS_PORT });
  wss.on('error', (err) => {
    endCall(err.code === 'EADDRINUSE'
      ? `A porta ${WS_PORT} já está em uso (outra instância do app aberta?).`
      : 'Erro no servidor: ' + err.message);
  });
  wss.on('connection', (socket) => {
    if (ws) { socket.close(); return; } // só aceita um amigo por vez
    ws = socket;
    setupSignalingHandlers();
    updateStatus('Conectando...', 'waiting');
    createPeerConnection(); // o addTrack dispara a negociação e o host envia a oferta
  });
}

function connectToSignalingServer(ip) {
  ending = false;
  updateStatus('Conectando...', 'waiting');
  noVideoText.textContent = 'Conectando ao anfitrião...';
  ws = new WebSocket(`ws://${ip}:${WS_PORT}`, { handshakeTimeout: 8000 });
  ws.on('open', () => {
    setupSignalingHandlers();
    createPeerConnection();
  });
  ws.on('error', () => endCall('Não foi possível conectar. Confira o IP, a Radmin VPN e o firewall (porta 8080).'));
}

function setupSignalingHandlers() {
  // Mensagens processadas em fila, uma de cada vez, para manter a ordem
  ws.on('message', (raw) => {
    messageQueue = messageQueue.then(() => handleSignal(JSON.parse(raw))).catch(console.error);
  });
  ws.on('close', () => endCall('O amigo desconectou.', 'info'));
}

function sendSignalingMsg(type, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, data }));
}

async function handleSignal({ type, data }) {
  if (!pc) return;

  if (type === 'screen-info') {
    // O amigo avisa qual stream é a tela dele (ou null quando para de transmitir)
    remoteScreenId = data;
    if (!data) { remoteVideo.srcObject = null; updateStage(); }
    return;
  }

  if (type === 'description') {
    const collision = data.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
    ignoreOffer = !polite && collision;
    if (ignoreOffer) return;
    await pc.setRemoteDescription(data);
    if (data.type === 'offer') {
      await pc.setLocalDescription();
      sendSignalingMsg('description', pc.localDescription);
    }
    return;
  }

  if (type === 'ice-candidate') {
    try {
      await pc.addIceCandidate(data);
    } catch (err) {
      if (!ignoreOffer) console.error('ICE candidate error', err);
    }
  }
}

// ---------- WebRTC ----------
function createPeerConnection() {
  pc = new RTCPeerConnection(rtcConfig);
  makingOffer = false;
  ignoreOffer = false;
  remoteScreenId = null;

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      sendSignalingMsg('description', pc.localDescription);
    } catch (err) {
      console.error(err);
    } finally {
      makingOffer = false;
    }
  };

  pc.onicecandidate = (e) => { if (e.candidate) sendSignalingMsg('ice-candidate', e.candidate); };

  pc.ontrack = (event) => {
    const stream = event.streams[0];
    if (!stream) return;
    if (stream.id === remoteScreenId) {
      if (remoteVideo.srcObject !== stream) remoteVideo.srcObject = stream; // tela do amigo
      applySpeaker();
    } else if (remoteVoice.srcObject !== stream) {
      remoteVoice.srcObject = stream; // voz do amigo
    }
    updateStage();
  };

  pc.onsignalingstatechange = () => {
    if (pc && pc.signalingState === 'stable') applyScreenEncoding();
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    const state = pc.connectionState;
    clearTimeout(disconnectTimer);
    if (state === 'connected') {
      updateStatus('Conectado via VPN', 'connected');
      noVideoText.textContent = 'Nenhuma tela sendo transmitida';
    } else if (state === 'disconnected') {
      // Pode ser só uma oscilação: espera alguns segundos antes de desistir
      disconnectTimer = setTimeout(() => {
        if (pc && pc.connectionState === 'disconnected') endCall('Conexão perdida.');
      }, 6000);
    } else if (state === 'failed') {
      endCall('Falha na conexão com o amigo.');
    }
  };

  micSender = null;
  localStream.getTracks().forEach(track => {
    const sender = pc.addTrack(track, localStream);
    if (track.kind === 'audio') micSender = sender;
  });
}

// ---------- Microfone ----------
btnMic.addEventListener('click', () => {
  if (!localStream) return;
  isMicMuted = !isMicMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !isMicMuted; });
  btnMic.innerText = isMicMuted ? 'Ativar Mic' : 'Desativar Mic';
  btnMic.className = isMicMuted ? 'btn-danger' : 'btn-primary';
});

// ---------- Compartilhamento de tela ----------
btnScreen.addEventListener('click', () => {
  if (screenStream) stopScreenShare();
  else openPicker();
});

async function openPicker() {
  selectedSourceId = null;
  pickerConfirm.disabled = true;
  pickerGrid.innerHTML = '<p class="hint">Carregando telas e janelas...</p>';
  picker.classList.remove('hidden');

  try {
    const sources = await ipcRenderer.invoke('get-sources');
    pickerGrid.innerHTML = '';
    // Telas primeiro, depois janelas
    sources.sort((a, b) => Number(b.isScreen) - Number(a.isScreen));
    sources.forEach(src => {
      const card = document.createElement('div');
      card.className = 'source-card';
      card.innerHTML = `
        <img class="thumb" src="${src.thumbnail}" alt="">
        <div class="source-name">${src.icon ? `<img src="${src.icon}" alt="">` : ''}<span></span></div>`;
      card.querySelector('span').textContent = src.name; // textContent evita injetar HTML do título da janela
      card.title = src.name;
      card.addEventListener('click', () => {
        pickerGrid.querySelectorAll('.source-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        selectedSourceId = src.id;
        pickerConfirm.disabled = false;
      });
      card.addEventListener('dblclick', () => { card.click(); pickerConfirm.click(); });
      pickerGrid.appendChild(card);
    });
    // Já deixa a primeira tela pré-selecionada
    pickerGrid.querySelector('.source-card')?.click();
  } catch (err) {
    console.error(err);
    picker.classList.add('hidden');
    toast('Não foi possível listar as telas.');
  }
}

pickerCancel.addEventListener('click', () => picker.classList.add('hidden'));
picker.addEventListener('click', (e) => { if (e.target === picker) picker.classList.add('hidden'); });

pickerConfirm.addEventListener('click', async () => {
  if (!selectedSourceId || !pc) return;
  picker.classList.add('hidden');
  currentQuality = QUALITY[optQuality.value] || QUALITY['1080p30'];

  try {
    await ipcRenderer.invoke('select-source', { id: selectedSourceId, audio: optAudio.checked });
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { max: currentQuality.width },
        height: { max: currentQuality.height },
        frameRate: { max: currentQuality.fps }
      },
      audio: optAudio.checked
    });
  } catch (e) {
    console.error('Compartilhamento cancelado', e);
    screenStream = null;
    return;
  }

  const videoTrack = screenStream.getVideoTracks()[0];
  if (videoTrack) videoTrack.contentHint = 'motion';
  videoTrack.onended = stopScreenShare; // usuário parou pelo sistema

  // Avisa o amigo qual stream é a tela ANTES de adicionar as faixas (a mensagem chega primeiro)
  sendSignalingMsg('screen-info', screenStream.id);
  screenSenders = screenStream.getTracks().map(t => pc.addTrack(t, screenStream));

  localVideo.srcObject = screenStream;
  swapped = true; // o que eu transmito aparece no meio por padrão
  btnScreen.innerText = 'Parar Compartilhamento';
  btnScreen.className = 'btn-danger';
  updateStage();
});

// Define bitrate / fps da tela transmitida (só funciona depois da negociação)
async function applyScreenEncoding() {
  for (const sender of screenSenders) {
    if (sender.track?.kind !== 'video') continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = currentQuality.bitrate;
      params.encodings[0].maxFramerate = currentQuality.fps;
      params.degradationPreference = 'maintain-framerate';
      await sender.setParameters(params);
    } catch (err) {
      console.warn('Não foi possível ajustar a qualidade', err);
    }
  }
}

function stopScreenShare() {
  if (!screenStream) return;
  const stream = screenStream;
  screenStream = null;

  stream.getTracks().forEach(t => { t.onended = null; t.stop(); });
  if (pc && pc.signalingState !== 'closed') {
    screenSenders.forEach(s => { try { pc.removeTrack(s); } catch { /* já removido */ } });
    sendSignalingMsg('screen-info', null);
  }
  screenSenders = [];

  localVideo.srcObject = null;
  swapped = false;
  btnScreen.innerText = 'Compartilhar Tela';
  btnScreen.className = 'btn-secondary';
  updateStage();
}

// ---------- Palco: o que aparece no centro da tela ----------
function updateStage() {
  const hasRemote = !!remoteVideo.srcObject;
  const hasLocal = !!localVideo.srcObject;

  remoteVideo.classList.add('hidden');
  localVideo.classList.add('hidden');
  remoteVideo.classList.remove('main', 'pip');
  localVideo.classList.remove('main', 'pip');

  let label = '';
  if (hasRemote && hasLocal) {
    const main = swapped ? localVideo : remoteVideo;
    const mini = swapped ? remoteVideo : localVideo;
    main.classList.remove('hidden'); main.classList.add('main');
    mini.classList.remove('hidden'); mini.classList.add('pip');
    label = swapped ? 'Você está transmitindo (clique na miniatura para ver o amigo)' : 'Tela do amigo (clique na miniatura para ver a sua)';
  } else if (hasRemote) {
    remoteVideo.classList.remove('hidden'); remoteVideo.classList.add('main');
    label = 'Tela do amigo';
  } else if (hasLocal) {
    localVideo.classList.remove('hidden'); localVideo.classList.add('main');
    label = 'Você está transmitindo';
  }

  noVideoText.style.display = (hasRemote || hasLocal) ? 'none' : 'flex';
  stageLabel.textContent = label;
}

// Clicar na miniatura troca qual vídeo fica no centro
[remoteVideo, localVideo].forEach(v => v.addEventListener('click', () => {
  if (v.classList.contains('pip')) { swapped = !swapped; updateStage(); }
}));

// ---------- Tela cheia ----------
function mainVideo() {
  return stage.querySelector('.stage-video.main');
}

function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen();
  const target = mainVideo();
  if (!target) return toast('Nenhuma tela para ver em tela cheia.', 'info', 2500);
  target.requestFullscreen().catch(err => toast('Erro ao ativar tela cheia: ' + err.message));
}

btnFullscreen.addEventListener('click', toggleFullscreen);
[remoteVideo, localVideo].forEach(v => v.addEventListener('dblclick', () => {
  if (v.classList.contains('main')) toggleFullscreen();
}));

// ---------- Encerrar: limpa tudo e volta para o início ----------
btnEnd.addEventListener('click', () => endCall());

function endCall(message, type = 'error') {
  if (ending) return;
  ending = true;
  clearTimeout(disconnectTimer);

  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  picker.classList.add('hidden');

  // Cada passo isolado: se um falhar, os outros ainda acontecem
  const safe = (fn) => { try { fn(); } catch (err) { console.error('Erro ao limpar:', err); } };

  safe(() => stopScreenShare());
  safe(() => localStream?.getTracks().forEach(t => t.stop()));
  safe(() => { if (pc) { pc.onconnectionstatechange = null; pc.close(); } });
  safe(() => { if (ws) { ws.removeAllListeners('close'); ws.close(); } });
  safe(() => wss?.close());

  pc = null; ws = null; wss = null;
  localStream = null; micSender = null;
  screenStream = null; screenSenders = [];
  remoteScreenId = null;
  messageQueue = Promise.resolve();

  resetCallUi();
  noVideoText.textContent = 'Nenhuma tela sendo transmitida';
  switchToSetupScreen();
  updateStatus('Desconectado');
  showMyIp();
  loadAudioDevices().catch(() => {}); // mantém as listas de dispositivos disponíveis na tela inicial

  if (message) toast(message, type);
}

// Lista de dispositivos já na tela inicial (rótulos completos só aparecem após permissão do microfone)
navigator.mediaDevices.enumerateDevices().then(() => loadAudioDevices()).catch(() => {});
