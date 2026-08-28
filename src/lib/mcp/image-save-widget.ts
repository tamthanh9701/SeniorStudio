export const IMAGE_SAVE_WIDGET_URI = "ui://seniorstudio/image-save-v1.html";

export const IMAGE_SAVE_WIDGET_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; padding: 16px; background: transparent; }
    .card { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 14px; padding: 16px; }
    h2 { margin: 0 0 8px; font-size: 18px; }
    p { margin: 6px 0; opacity: .78; font-size: 14px; }
    button, .upload { display: inline-flex; align-items: center; justify-content: center; margin-top: 14px; border: 0; border-radius: 9px; padding: 10px 14px; background: #2563eb; color: white; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: .5; cursor: wait; }
    input[type=file] { display: none; }
    #status { margin-top: 12px; white-space: pre-wrap; }
    .success { color: #15803d; }
    .error { color: #dc2626; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Save image to SeniorStudio</h2>
    <p id="target">Choose the exact PNG, JPEG, or WebP file to save.</p>
    <button id="library" type="button">Choose from ChatGPT files</button>
    <label class="upload" for="upload">Upload from device</label>
    <input id="upload" type="file" accept="image/png,image/jpeg,image/webp" />
    <div id="status" role="status"></div>
  </div>
<script>
(() => {
  const api = window.openai;
  const library = document.getElementById('library');
  const upload = document.getElementById('upload');
  const status = document.getElementById('status');
  const target = document.getElementById('target');
  let config = api && api.toolOutput ? api.toolOutput : null;

  function setStatus(message, kind) {
    status.textContent = message;
    status.className = kind || '';
  }
  function refreshConfig() {
    config = (window.openai && window.openai.toolOutput) || config;
    if (!config) return;
    target.textContent = config.mode === 'edit'
      ? 'Save an edited image as a new version of the selected SeniorStudio asset.'
      : 'Save the exact generated image to project: ' + config.project_name;
  }
  window.addEventListener('openai:set_globals', refreshConfig, { passive: true });
  refreshConfig();

  async function saveFile(file) {
    refreshConfig();
    if (!config) throw new Error('Widget configuration is unavailable. Reopen the save widget.');
    if (!window.openai || !window.openai.getFileDownloadUrl || !window.openai.callTool) {
      throw new Error('This ChatGPT client does not expose the required file APIs.');
    }
    setStatus('Preparing the exact file…');
    const urlResult = await window.openai.getFileDownloadUrl({ fileId: file.fileId });
    if (!urlResult || !urlResult.downloadUrl) throw new Error('ChatGPT did not provide a temporary download URL.');
    const image = {
      download_url: urlResult.downloadUrl,
      file_id: file.fileId,
      mime_type: file.mimeType || undefined,
      file_name: file.fileName || undefined
    };
    const args = config.mode === 'edit'
      ? { asset_id: config.asset_id, parent_version_id: config.parent_version_id, image, prompt: config.prompt, notes: config.notes }
      : { project_id: config.project_id, image, name: config.name, prompt: config.prompt, notes: config.notes };
    setStatus('Saving to SeniorStudio…');
    const result = await window.openai.callTool(config.mode === 'edit' ? 'save_edited_image' : 'save_generated_image', args);
    if (result && result.isError) throw new Error('SeniorStudio rejected the file.');
    setStatus('Saved successfully. The image is now available in SeniorStudio.', 'success');
  }

  library.addEventListener('click', async () => {
    try {
      if (!window.openai || !window.openai.selectFiles) throw new Error('ChatGPT file picker is unavailable. Use Upload from device.');
      library.disabled = true;
      const files = await window.openai.selectFiles();
      if (!files || files.length === 0) { setStatus('No file selected.'); return; }
      await saveFile(files[0]);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error), 'error'); }
    finally { library.disabled = false; }
  });

  upload.addEventListener('change', async () => {
    try {
      const file = upload.files && upload.files[0];
      if (!file) return;
      if (!window.openai || !window.openai.uploadFile) throw new Error('ChatGPT upload API is unavailable.');
      setStatus('Uploading file to ChatGPT…');
      const uploaded = await window.openai.uploadFile(file, { library: false });
      await saveFile({ fileId: uploaded.fileId, fileName: file.name, mimeType: file.type });
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error), 'error'); }
  });
})();
</script>
</body>
</html>`;
