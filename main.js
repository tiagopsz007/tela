const { app, BrowserWindow, systemPreferences, desktopCapturer, session, ipcMain } = require('electron');
const path = require('path');

let mainWindow;
// Fonte escolhida pelo usuário no seletor de tela (definida via IPC antes do getDisplayMedia)
let pendingShare = { id: null, audio: false };

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 860,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: '#111827',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // Lista telas e janelas (com miniatura) para o seletor do app. A própria janela do app fica de fora.
  ipcMain.handle('get-sources', async () => {
    const ownId = mainWindow.getMediaSourceId();
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    });
    return sources
      .filter(s => s.id !== ownId)
      .map(s => ({
        id: s.id,
        name: s.name,
        isScreen: s.id.startsWith('screen:'),
        thumbnail: s.thumbnail.toDataURL(),
        icon: s.appIcon ? s.appIcon.toDataURL() : null
      }));
  });

  ipcMain.handle('select-source', (_event, { id, audio }) => {
    pendingShare = { id, audio: !!audio };
  });

  // Responde ao getDisplayMedia() do renderer com a fonte escolhida
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const chosen = sources.find(s => s.id === pendingShare.id) || sources.find(s => s.id.startsWith('screen:'));
      if (!chosen) return callback({});
      const result = { video: chosen };
      if (pendingShare.audio) result.audio = 'loopback'; // áudio do sistema (Windows)
      callback(result);
    } catch (err) {
      console.error('Erro ao obter fontes de captura:', err);
      callback({});
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  if (process.platform === 'win32') {
    systemPreferences.askForMediaAccess('microphone');
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
