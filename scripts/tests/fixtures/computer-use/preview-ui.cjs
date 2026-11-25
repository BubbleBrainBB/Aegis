// Run in the Electron workstream harness. Both the target window and chat belong to the test.
const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain } = require('electron');

module.exports = async function verifyPreview({ w, js, until, click, shot }) {
  const target = new BrowserWindow({ width: 800, height: 450, frame: false, show: false, backgroundColor: '#386478' });
  try {
    await target.loadURL('data:text/html,' + encodeURIComponent('<body style="background:#386478;color:white;font:24px system-ui;padding:1em">Document preview</body>'));
    target.showInactive();
    const id = Number(target.getMediaSourceId().split(':')[1]);
    const poster = (await target.webContents.capturePage()).toDataURL();
    w.setContentSize(1492, 1039);
    await js('window.previewTest=true;qa.chat();qa.activateOtherSession(false)');
    await until('!!document.querySelector("#real-chat")', 'ChatPane');
    await js(`(() => {
      const sessionId = qa.chatId;
      const event = (type,payload) => qa.store.getState().handleServerEvent({type,payload:{sessionId,...payload}});
      const media = {sessionId,sha256:"1".repeat(64),mimeType:"image/png",sizeBytes:100};
      window.previewShot = (windowId) => event("computerUse.live",{frame:{threadId:sessionId,toolUseId:"observe",app:"Preview",tool:"get_app_state",label:"正在打开主窗口",at:Date.now(),media,hasFreshMedia:true,previewWindowId:windowId}});
      window.electron.readComputerUseArtifact=async()=>${JSON.stringify(poster)};
      window.electron.stopComputerUse=async(id)=>{window.stoppedSession=id;event("computerUse.stopped",{})};
      window.electron.openComputerUsePreview=async(data)=>{window.openedSession=data.sessionId;event("computerUse.preview",{open:true})};
      qa.store.setState(s=>({sessions:{...s.sessions,[sessionId]:{...s.sessions[sessionId],title:'打开剪映',provider:'claude',status:'running',messages:[
        {type:'user_prompt',prompt:'用 Computer Use 打开剪映',createdAt:1000},
        {type:'assistant',uuid:'note',createdAt:1100,message:{content:[{type:'text',text:'我用 Computer Use 打开剪映。'}]}},
        {type:'assistant',uuid:'observe',createdAt:1200,message:{content:[{type:'tool_use',id:'observe',name:'mcp__aegis-computer-use__get_app_state',input:{app:'Preview',toolTitle:'正在打开剪映主窗口'}}]}}
      ]}}}));
      previewShot(${id});
    })()`);
    const pip = '.computer-use-pip[data-placement="floating"]';
    await until('!!document.querySelector(' + JSON.stringify(pip) + ')', 'floating preview');
    await until('document.querySelector("[data-workstream-stage] > button")?.textContent.includes("正在打开剪映主窗口")', 'inline action');
    const row = '[data-workstream-stage] > button';
    assert.equal(await js(`document.querySelector('${row}').getAttribute('aria-expanded')`), 'false');
    await click(row);
    assert.equal(await js(`document.querySelector('${row}').getAttribute('aria-expanded')`), 'true');
    await click(row);
    if (process.platform === 'darwin') {
      await until('document.querySelector(".computer-use-pip video")?.videoWidth > 0 && !document.querySelector(".computer-use-pip video").hidden', 'exact-window video');
      const pixel = `(() => {const c=document.createElement('canvas').getContext('2d');c.drawImage(document.querySelector('.computer-use-pip video'),0,0,80,45);return c.getImageData(60,30,1,1).data[1]})()`;
      await until(pixel + '>80 && ' + pixel + '<130', 'first live color');
      await target.webContents.executeJavaScript('document.body.style.background="#20db42"');
      await until(pixel + '>195', 'same window changed between tool calls');
      await target.webContents.executeJavaScript('document.body.style.background="#386478"');
      await until(pixel + '<130', 'restored frame');
    }
    const geometry = await js(`(() => {
      const pip=document.querySelector('.computer-use-pip'),surface=pip.offsetParent.getBoundingClientRect(),p=pip.getBoundingClientRect();
      return {x:p.x-surface.x,y:p.y-surface.y,width:p.width,height:p.height,controls:getComputedStyle(pip.querySelector('.computer-use-pip-controls')).opacity}
    })()`);
    console.log('Floating window relative to chat surface:', geometry);
    assert(Math.abs(geometry.width - 200) <= 1 && Math.abs(geometry.height - 112.5) <= 1);
    assert(geometry.x >= 68 && geometry.x <= 74 && geometry.y === 10);
    assert.equal(geometry.controls, '0');
    if (process.env.QA_PREVIEW_WINDOW_IMAGE) {
      // For visual comparison only, show the supplied window contents inside our test target.
      const data = require('node:fs').readFileSync(process.env.QA_PREVIEW_WINDOW_IMAGE).toString('base64');
      await target.webContents.executeJavaScript(`(async()=>{const img=new Image();img.src='data:image/png;base64,${data}';await img.decode();document.body.replaceChildren(img);Object.assign(img.style,{position:'fixed',inset:'0',width:'100%',height:'100%'})})()`);
      await until(`(() => {const c=document.createElement('canvas').getContext('2d');c.drawImage(document.querySelector('.computer-use-pip video'),0,0,80,45);return c.getImageData(60,30,1,1).data[1] < 85})()`, 'reference contents in live preview');
    }
    assert(await js('document.querySelector("aside .environment-summary-section").innerText.includes("Picture in Picture")'));
    assert.equal(await js('document.querySelector("aside .environment-summary-section").innerText.includes(".png")'), false);
    await shot('chat');
    await click('[aria-label="Move to sidebar"]');
    await until('!!document.querySelector(".computer-use-pip[data-placement=sidebar]")','sidebar preview');
    assert.equal(await js('document.querySelectorAll(".computer-use-pip").length'),1);
    await click('[aria-label="Move to chat"]');
    await click('[aria-label="Hide picture in picture"]');
    assert.equal(await js('document.querySelectorAll(".computer-use-pip").length'),0);
    await click('[aria-label="Show picture in picture"]');
    await until('!!document.querySelector(".computer-use-pip")','restored preview');
    await click('[aria-label="Move to floating window"]');
    assert(await js('openedSession===qa.chatId'));
    await js('qa.store.getState().handleServerEvent({type:"computerUse.preview",payload:{open:false,sessionId:qa.chatId}})');
    await click('[aria-label="Open Computer Use preview"]');
    assert(await js('openedSession===qa.chatId'));
    await js('qa.store.getState().handleServerEvent({type:"computerUse.preview",payload:{open:false,sessionId:qa.chatId}})');
    await until('!!document.querySelector(".computer-use-pip")','docked preview');
    await js('window.testTrack=document.querySelector(".computer-use-pip video").srcObject?.getTracks()[0]');
    await click('[aria-label="Stop Computer Use"]');
    assert(await js('stoppedSession===qa.chatId && !document.querySelector(".computer-use-pip") && (!testTrack || testTrack.readyState==="ended")'));
    assert(await js('qa.store.getState().sessions[qa.chatId].computerUseFrames.length > 0'));
    assert.equal(await js('!!document.querySelector("aside .environment-summary-section")'), false);
    await js('previewShot(undefined)');
    await until('!!document.querySelector(".computer-use-pip img")','snapshot-only provider');
    await js('qa.activateOtherSession(true)');
    assert.equal(await js('document.querySelectorAll(".computer-use-pip").length'),0);
    const savedFrame = await js('qa.store.getState().sessions[qa.chatId].computerUseLive');
    await js('qa.activateOtherSession(false);qa.store.getState().handleServerEvent({type:"session.status",payload:{sessionId:qa.chatId,status:"completed"}})');
    assert(await js('qa.store.getState().sessions[qa.chatId].computerUseFrames.length > 0'));
    assert.equal(await js('!!document.querySelector("aside .environment-summary-section")'), false);
    await shot('completed');
    if (process.platform === 'darwin') {
      // Load the built preview renderer and preload in the real native window.
      app.setAppPath(process.cwd());
      process.env.DEV_SERVER_URL = 'http://127.0.0.1:1';
      const native = require(require('node:path').join(process.cwd(), 'dist-electron/electron/libs/computer-use-preview-window.js'));
      native.attachComputerUsePreviewHost(w);
      ipcMain.on('renderer-state:get-all-sync', event => { event.returnValue = {}; });
      ipcMain.on('get-ui-resume-state-sync', event => { event.returnValue = null; });
      ipcMain.handle('set-theme', () => {});
      ipcMain.handle('get-app-preferences', () => ({}));
      ipcMain.on('fit-computer-use-preview', (event, width, height) => native.fitComputerUsePreview(event.sender.id, width, height));
      ipcMain.handle('get-computer-use-preview-state', () => native.getComputerUsePreviewSnapshot());
      ipcMain.handle('read-computer-use-artifact', () => poster);
      ipcMain.handle('close-computer-use-preview', () => native.closeComputerUsePreviewWindow());
      const frame = savedFrame;
      native.rememberComputerUseLive(frame.threadId, { ...frame, previewWindowId: id });
      const focused = BrowserWindow.getFocusedWindow();
      await native.openComputerUsePreviewWindow({ sessionId: frame.threadId });
      const floating = BrowserWindow.getAllWindows().find(win => win !== target && win !== w);
      assert(floating?.isAlwaysOnTop());
      for (let i=0; i<80; i++) {
        if (await floating.webContents.executeJavaScript('!!document.querySelector("video")?.videoWidth')) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert(await floating.webContents.executeJavaScript('!!document.querySelector("video")?.videoWidth'), 'native window plays the observed target');
      assert.equal(BrowserWindow.getFocusedWindow()?.id, focused?.id, 'floating the preview leaves focus alone');
      target.setContentSize(440, 540);
      for (let i=0; i<60 && floating.getContentSize()[1]!==200; i++) await new Promise(resolve => setTimeout(resolve, 100));
      const [width,height] = floating.getContentSize();
      assert(height===200 && Math.abs(width-200*440/540)<2, 'native preview follows a portrait window resize');
      await floating.webContents.executeJavaScript('document.querySelector("[aria-label=Dock]").click()');
      assert.equal(native.isComputerUsePreviewOpen(), false);
      await native.openComputerUsePreviewWindow({sessionId: frame.threadId});
      native.clearComputerUseLive(frame.threadId);
      assert.equal(native.isComputerUsePreviewOpen(), false);
      assert.equal((await native.openComputerUsePreviewWindow({sessionId: frame.threadId, frames: [frame]})).open, false);
      console.log('Native picture in picture plays the target window, preserves focus and docks.');
    }
    console.log('Action disclosure, live preview, placement, hide/show, session binding, fallback and Stop passed.');
  } finally { target.destroy(); }
};
