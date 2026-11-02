const { app, BrowserWindow, systemPreferences, desktopCapturer, session } = require('electron');
const path = require('path');

let mainWindow;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 800,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: '#111827',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // Autoriza a captura de vídeo e áudio do sistema (loopback)
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(err => {
      console.error("Erro ao obter telas:", err);
    });
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