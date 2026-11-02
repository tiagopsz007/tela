const WebSocket = require('ws');

const setupScreen = document.getElementById('setup-screen');
const callScreen = document.getElementById('call-screen');
const statusBadge = document.getElementById('connection-status');
const remoteVideo = document.getElementById('remote-video');
const remoteVoice = document.getElementById('remote-voice');
const micSelect = document.getElementById('mic-select');

const btnHost = document.getElementById('btn-host');
const btnConnect = document.getElementById('btn-connect');
const btnMic = document.getElementById('btn-mic');
const btnScreen = document.getElementById('btn-screen');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnEnd = document.getElementById('btn-end');
const targetIpInput = document.getElementById('target-ip');

let ws;
let peerConnection;
let localStream;
let screenStream;
let isHost = false;
let isMicMuted = false;

const wsPort = 8080;
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Carrega a lista de microfones ao abrir o app
navigator.mediaDevices.enumerateDevices().then(devices => {
  devices.filter(d => d.kind === 'audioinput').forEach(mic => {
    const option = document.createElement('option');
    option.value = mic.deviceId;
    option.text = mic.label || `Microfone ${micSelect.length + 1}`;
    micSelect.appendChild(option);
  });
});

// Troca de microfone em tempo real
micSelect.addEventListener('change', async () => {
  if (!localStream || !peerConnection) return;
  const newMicStream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: micSelect.value } }
  });
  
  const newAudioTrack = newMicStream.getAudioTracks()[0];
  newAudioTrack.enabled = !isMicMuted;
  
  // Substitui a faixa antiga no envio P2P
  const sender = peerConnection.getSenders().find(s => s.track.kind === 'audio' && !screenStream?.getTracks().includes(s.track));
  if (sender) sender.replaceTrack(newAudioTrack);
  
  localStream.getAudioTracks()[0].stop(); // Desliga o mic antigo
  localStream = newMicStream; // Atualiza a referência
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

function startSignalingServer() {
  const wss = new WebSocket.Server({ port: wsPort });
  wss.on('connection', (socket) => {
    ws = socket;
    setupSignalingHandlers();
    createPeerConnection();
    peerConnection.createOffer()
      .then(offer => peerConnection.setLocalDescription(offer))
      .then(() => sendSignalingMsg('offer', peerConnection.localDescription));
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
    } 
    else if (data.type === 'answer') {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.data));
    } 
    else if (data.type === 'ice-candidate') {
      await peerConnection.addIceCandidate(new RTCIceCandidate(data.data));
    }
  });
  ws.on('close', endCall);
}

function sendSignalingMsg(type, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, data }));
}

async function initLocalMedia() {
  try {
    const deviceId = micSelect.value ? { exact: micSelect.value } : undefined;
    localStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId }, video: false });
    switchToCallScreen();
  } catch (e) {
    alert("Erro ao aceder ao microfone: " + e.message);
  }
}

function createPeerConnection() {
  peerConnection = new RTCPeerConnection(rtcConfig);

  // Envia o microfone (Stream 1)
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  // Recebe faixas e roteia para a tag HTML correta
  peerConnection.ontrack = (event) => {
    const stream = event.streams[0];
    
    // Se a stream recebida contiver vídeo, é o Compartilhamento de Tela (Vídeo + Áudio do PC)
    if (stream.getVideoTracks().length > 0) {
      remoteVideo.srcObject = stream;
    } else {
      // Se não tiver vídeo, é a voz do microfone do amigo
      remoteVoice.srcObject = stream;
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) sendSignalingMsg('ice-candidate', event.candidate);
  };

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
      // Pede permissão para capturar tela E áudio do sistema
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: "always" }, audio: true });
      
      // Envia todas as faixas (Vídeo e Áudio do PC) gerando uma Stream nova (Stream 2)
      screenStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, screenStream);
        track.onended = stopScreenShare;
      });
      
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
    btnScreen.innerText = "Partilhar Ecrã";
    btnScreen.className = "btn-secondary";
    
    peerConnection.createOffer()
      .then(offer => peerConnection.setLocalDescription(offer))
      .then(() => sendSignalingMsg('offer', peerConnection.localDescription));
  }
}

// Botão de Tela Cheia
btnFullscreen.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    remoteVideo.requestFullscreen().catch(err => alert(`Erro ao ativar tela cheia: ${err.message}`));
  } else {
    document.exitFullscreen();
  }
});

// Suporte a duplo-clique no vídeo para tela cheia
remoteVideo.addEventListener('dblclick', () => {
  if (!document.fullscreenElement) remoteVideo.requestFullscreen();
  else document.exitFullscreen();
});

btnEnd.addEventListener('click', endCall);

function endCall() {
  if (peerConnection) peerConnection.close();
  if (ws) ws.close();
  if (localStream) localStream.getTracks().forEach(track => track.stop());
  if (screenStream) stopScreenShare();
  
  peerConnection = null;
  ws = null;
  
  setupScreen.style.display = 'flex';
  callScreen.style.display = 'none';
  remoteVideo.srcObject = null;
  remoteVoice.srcObject = null;
  updateStatus('Desconectado', false);
}

function switchToCallScreen() {
  setupScreen.style.display = 'none';
  callScreen.style.display = 'flex';
}

function updateStatus(text, connected) {
  statusBadge.innerText = text;
  statusBadge.className = connected ? 'status connected' : 'status';
}