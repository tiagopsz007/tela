const WebSocket = require('ws');

const setupScreen = document.getElementById('setup-screen');
const callScreen = document.getElementById('call-screen');
const statusBadge = document.getElementById('connection-status');
const remoteVideo = document.getElementById('remote-video');
const remoteVoice = document.getElementById('remote-voice');
const localPreviewContainer = document.getElementById('local-preview-container');
const localScreenPreview = document.getElementById('local-screen-preview');
const micSelect = document.getElementById('mic-select');
const speakerSelect = document.getElementById('speaker-select');
const btnHost = document.getElementById('btn-host');
const btnConnect = document.getElementById('btn-connect');
const btnMic = document.getElementById('btn-mic');
const btnScreen = document.getElementById('btn-screen');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnEnd = document.getElementById('btn-end');
const targetIpInput = document.getElementById('target-ip');

let wss = null;
let ws;
let peerConnection;
let localStream;
let screenStream;
let isHost = false;
let isMicMuted = false;

const wsPort = 8080;
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Carrega os dispositivos apenas DEPOIS de pedir permissão de áudio para evitar listas vazias
async function loadAudioDevices() {
  micSelect.innerHTML = '';
  speakerSelect.innerHTML = '';
  const devices = await navigator.mediaDevices.enumerateDevices();
  let micCount = 1, speakerCount = 1;
  
  devices.forEach(device => {
    if (device.kind === 'audioinput') {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.text = device.label || `Microfone ${micCount++}`;
      micSelect.appendChild(option);
    } else if (device.kind === 'audiooutput') {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.text = device.label || `Saída de Áudio ${speakerCount++}`;
      speakerSelect.appendChild(option);
    }
  });
}

micSelect.addEventListener('change', async () => {
  if (!localStream || !peerConnection) return;
  const newMicStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: micSelect.value } } });
  const newAudioTrack = newMicStream.getAudioTracks()[0];
  newAudioTrack.enabled = !isMicMuted;
  
  const sender = peerConnection.getSenders().find(s => s.track.kind === 'audio' && !screenStream?.getTracks().includes(s.track));
  if (sender) sender.replaceTrack(newAudioTrack);
  
  localStream.getAudioTracks()[0].stop();
  localStream = newMicStream;
});

speakerSelect.addEventListener('change', async () => {
  const deviceId = speakerSelect.value;
  try {
    if (typeof remoteVoice.setSinkId === 'function') {
      await remoteVoice.setSinkId(deviceId);
      await remoteVideo.setSinkId(deviceId);
    }
  } catch (err) {
    console.error("Erro ao alterar saída de áudio", err);
  }
});

btnHost.addEventListener('click', async () => {
  isHost = true;
  await initLocalMedia();
  startSignalingServer();
  updateStatus('Aguardar conexão...', false);
});

btnConnect.addEventListener('click', async () => {
  const ip = targetIpInput.value.trim();
  if (!ip) return alert("Insira o IP da Radmin VPN do anfitrião.");
  isHost = false;
  await initLocalMedia();
  connectToSignalingServer(ip);
  updateStatus('A conectar...', false);
});

async function initLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    await loadAudioDevices(); // Carrega os nomes (fones/microfones) corretos agora que tem permissão
    switchToCallScreen();
  } catch (e) {
    alert("Erro ao aceder ao microfone: " + e.message);
  }
}

function startSignalingServer() {
  wss = new WebSocket.Server({ port: wsPort });
  wss.on('connection', (socket) => {
    ws = socket;
    setupSignalingHandlers();
    createPeerConnection();
    peerConnection.createOffer().then(offer => peerConnection.setLocalDescription(offer)).then(() => sendSignalingMsg('offer', peerConnection.localDescription));
  });
}

function connectToSignalingServer(ip) {
  ws = new WebSocket(`ws://${ip}:${wsPort}`);
  ws.on('open', () => {
    setupSignalingHandlers();
    createPeerConnection();
  });
  ws.on('error', () => updateStatus('Erro: O anfitrião não foi encontrado.', false));
}

function setupSignalingHandlers() {
  ws.on('message', async (message) => {
    const data = JSON.parse(message);
    if (data.type === 'offer') {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.data));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      sendSignalingMsg('answer', answer);
    } else if (data.type === 'answer') {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.data));
    } else if (data.type === 'ice-candidate') {
      await peerConnection.addIceCandidate(new RTCIceCandidate(data.data));
    }
  });
  ws.on('close', endCall);
}

function sendSignalingMsg(type, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, data }));
}

function createPeerConnection() {
  peerConnection = new RTCPeerConnection(rtcConfig);
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.ontrack = (event) => {
    const stream = event.streams[0];
    if (stream.getVideoTracks().length > 0) {
      remoteVideo.srcObject = stream; // Tela recebida do amigo
    } else {
      remoteVoice.srcObject = stream; // Voz do amigo
    }
  };

  peerConnection.onicecandidate = (event) => { if (event.candidate) sendSignalingMsg('ice-candidate', event.candidate); };
  peerConnection.oniceconnectionstatechange = () => {
    if (peerConnection.iceConnectionState === 'connected') updateStatus('Conectado via VPN', true);
    else if (peerConnection.iceConnectionState === 'disconnected') endCall();
  };
}

btnMic.addEventListener('click', () => {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  isMicMuted = !isMicMuted;
  audioTrack.enabled = !isMicMuted;
  btnMic.innerText = isMicMuted ? "Ativar Mic" : "Desativar Mic";
  btnMic.className = isMicMuted ? "btn-danger" : "btn-primary";
});

btnScreen.addEventListener('click', async () => {
  if (!screenStream) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: "always" }, audio: true });
      screenStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, screenStream);
        track.onended = stopScreenShare;
      });
      
      localScreenPreview.srcObject = screenStream;
      localPreviewContainer.style.display = 'block'; // Mostra a janela pequena (sua tela)

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      sendSignalingMsg('offer', peerConnection.localDescription);

      btnScreen.innerText = "Parar Partilha";
      btnScreen.className = "btn-danger";
    } catch (e) {
      console.error("Partilha cancelada", e);
    }
  } else {
    stopScreenShare();
  }
});

function stopScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach(track => {
      track.stop();
      const sender = peerConnection.getSenders().find(s => s.track === track);
      if (sender) peerConnection.removeTrack(sender);
    });
    screenStream = null;
    localScreenPreview.srcObject = null;
    localPreviewContainer.style.display = 'none';
    btnScreen.innerText = "Partilhar Ecrã";
    btnScreen.className = "btn-secondary";
    peerConnection.createOffer().then(offer => peerConnection.setLocalDescription(offer)).then(() => sendSignalingMsg('offer', peerConnection.localDescription));
  }
}

btnFullscreen.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    remoteVideo.requestFullscreen().catch(err => alert(`Erro ao ativar tela cheia: ${err.message}`));
  } else {
    document.exitFullscreen();
  }
});

remoteVideo.addEventListener('dblclick', () => {
  if (!document.fullscreenElement) remoteVideo.requestFullscreen();
  else document.exitFullscreen();
});

btnEnd.addEventListener('click', endCall);

function endCall() {
  // O bloco try-finally garante que a tela inicial sempre volte, mesmo que algo falhe ao desconectar
  try {
    if (peerConnection) peerConnection.close();
    if (ws) ws.close();
    if (wss) wss.close();
    if (localStream) localStream.getTracks().forEach(track => track.stop());
    if (screenStream) stopScreenShare();
  } catch (error) {
    console.error("Erro ao limpar dados:", error);
  } finally {
    peerConnection = null;
    ws = null;
    wss = null;
    setupScreen.style.display = 'flex';
    callScreen.style.display = 'none';
    remoteVideo.srcObject = null;
    remoteVoice.srcObject = null;
    updateStatus('Desconectado', false);
  }
}

function switchToCallScreen() {
  setupScreen.style.display = 'none';
  callScreen.style.display = 'flex';
}

function updateStatus(text, connected) {
  statusBadge.innerText = text;
  statusBadge.className = connected ? 'status connected' : 'status';
}