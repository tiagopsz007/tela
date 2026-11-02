const WebSocket = require('ws');

// Elementos da UI
const setupScreen = document.getElementById('setup-screen');
const callScreen = document.getElementById('call-screen');
const statusBadge = document.getElementById('connection-status');
const remoteVideo = document.getElementById('remote-video');

const btnHost = document.getElementById('btn-host');
const btnConnect = document.getElementById('btn-connect');
const btnMic = document.getElementById('btn-mic');
const btnScreen = document.getElementById('btn-screen');
const btnEnd = document.getElementById('btn-end');
const targetIpInput = document.getElementById('target-ip');

let ws;
let peerConnection;
let localStream;
let screenStream;
let isHost = false;
let isMicMuted = false;

const wsPort = 8080;
const rtcConfig = {
  // Como estamos em VPN (LAN virtual), STUN servers não são obrigatórios, mas ajudam em rotas difíceis.
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// ================= SISTEMA DE CONEXÃO (SIGNALING) ================= //

btnHost.addEventListener('click', async () => {
  isHost = true;
  startSignalingServer();
  await initLocalMedia();
  updateStatus('Aguardando conexão...', false);
});

btnConnect.addEventListener('click', async () => {
  const ip = targetIpInput.value.trim();
  if (!ip) return alert("Insira o IP do Radmin VPN do anfitrião.");
  isHost = false;
  await initLocalMedia();
  connectToSignalingServer(ip);
  updateStatus('Conectando...', false);
});

function startSignalingServer() {
  const wss = new WebSocket.Server({ port: wsPort });
  wss.on('connection', (socket) => {
    ws = socket;
    setupSignalingHandlers();
    createPeerConnection();
    // O anfitrião inicia a oferta WebRTC
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
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

// ================= WEBRTC E MÍDIA ================= //

async function initLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    switchToCallScreen();
  } catch (e) {
    alert("Erro ao acessar microfone: " + e.message);
  }
}

function createPeerConnection() {
  peerConnection = new RTCPeerConnection(rtcConfig);

  // Adiciona a voz local na conexão
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  // Recebe voz/tela remota
  peerConnection.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
    }
  };

  // Troca de rotas P2P
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) sendSignalingMsg('ice-candidate', event.candidate);
  };

  peerConnection.oniceconnectionstatechange = () => {
    if (peerConnection.iceConnectionState === 'connected') {
      updateStatus('Conectado via VPN', true);
    } else if (peerConnection.iceConnectionState === 'disconnected') {
      endCall();
    }
  };
}

// ================= CONTROLES DA INTERFACE ================= //

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
      // Solicita captura de tela. O Electron invoca o seletor nativo do Windows.
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: "always" }, audio: true });
      
      const videoTrack = screenStream.getVideoTracks()[0];
      peerConnection.addTrack(videoTrack, screenStream);
      
      // Renegocia a conexão WebRTC para incluir o novo canal de vídeo
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      sendSignalingMsg('offer', peerConnection.localDescription);

      btnScreen.innerText = "Parar Compartilhamento";
      btnScreen.className = "btn-danger";

      videoTrack.onended = stopScreenShare; // Se usuário fechar a tela nativamente
    } catch (e) {
      console.error("Compartilhamento cancelado", e);
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
    btnScreen.innerText = "Compartilhar Tela";
    btnScreen.className = "btn-secondary";
    
    // Atualiza o PeerConnection sem o vídeo
    peerConnection.createOffer()
      .then(offer => peerConnection.setLocalDescription(offer))
      .then(() => sendSignalingMsg('offer', peerConnection.localDescription));
  }
}

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