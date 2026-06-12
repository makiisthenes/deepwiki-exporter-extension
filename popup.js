document.addEventListener('DOMContentLoaded', () => {
  const convertBtn = document.getElementById('convertBtn');
  const batchDownloadBtn = document.getElementById('batchDownloadBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const status = document.getElementById('status');
  let currentMarkdown = '';
  let currentTitle = '';
  let currentHeadTitle = '';
  let allPages = [];
  let baseUrl = '';
  let convertedPages = []; // Store all converted page content
  let isCancelled = false; // Flag to control cancellation
  let isDevinMode = false; // Devin SPA: navigate by clicking sidebar buttons

  function isSupportedUrl(url) {
    try {
      const { hostname, protocol } = new URL(url);
      return protocol === 'https:' && (hostname === 'deepwiki.com' || hostname === 'app.devin.ai');
    } catch (e) {
      return false;
    }
  }

  function sanitizeFilename(name) {
    if (!name || typeof name !== 'string') return 'Untitled';
    // Normalize unicode, remove control chars, replace invalid filename chars
    let cleaned = name
      .normalize('NFKD')
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^\.+|\.+$/g, '')
      .trim();
    if (!cleaned) cleaned = 'Untitled';
    if (cleaned.length > 120) cleaned = cleaned.slice(0, 120);
    return cleaned;
  }

  // Convert button click event - now also downloads
  convertBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!isSupportedUrl(tab.url)) {
        showStatus('Please use this extension on a DeepWiki or Devin page', 'error');
        return;
      }

      showStatus('Converting page...', 'info');
      let response;
      try {
        response = await chrome.tabs.sendMessage(tab.id, { action: 'convertToMarkdown' });
      } catch (e) {
        // Fallback: inject content script then retry
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
          });
          response = await chrome.tabs.sendMessage(tab.id, { action: 'convertToMarkdown' });
        } catch (injectErr) {
          throw injectErr;
        }
      }
      
      if (response && response.success) {
        currentMarkdown = response.markdown;
        currentTitle = response.markdownTitle;
        currentHeadTitle = response.headTitle || '';
        
        // Create filename with head title and content title
        const rawName = currentHeadTitle 
          ? `${currentHeadTitle}-${currentTitle}` 
          : `${currentTitle}`;
        const fileName = `${sanitizeFilename(rawName)}.md`;
        
        // Automatically download after successful conversion
        const blob = new Blob([currentMarkdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        
        chrome.downloads.download({
          url: url,
          filename: fileName,
          saveAs: true
        });
        
        showStatus('Conversion successful! Downloading...', 'success');
      } else {
        showStatus('Conversion failed: ' + (response?.error || 'Unknown error'), 'error');
      }
    } catch (error) {
      showStatus('An error occurred: ' + error.message, 'error');
    }
  });

  // Batch download button click event
  batchDownloadBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!isSupportedUrl(tab.url)) {
        showStatus('Please use this extension on a DeepWiki or Devin page', 'error');
        return;
      }

      // Reset cancellation flag and show cancel button
      isCancelled = false;
      showCancelButton(true);
      disableBatchButton(true);

      showStatus('Extracting all page links...', 'info');
      
      // Extract all links first (with injection fallback)
      let response;
      try {
        response = await chrome.tabs.sendMessage(tab.id, { action: 'extractAllPages' });
      } catch (e) {
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
          response = await chrome.tabs.sendMessage(tab.id, { action: 'extractAllPages' });
        } catch (injectErr) {
          throw injectErr;
        }
      }
      
      if (response && response.success) {
        allPages = response.pages;
        baseUrl = response.baseUrl;
        isDevinMode = !!response.isDevin;
        
        // Use head title for folder name if available
        const headTitle = response.headTitle || '';
        const folderName = sanitizeFilename(headTitle || response.currentTitle);
        
        // Clear previous conversion results
        convertedPages = [];
        
        showStatus(`Found ${allPages.length} pages, starting batch conversion`, 'info');
        
        // Process all pages - collect conversion results
        await processAllPages(tab.id, folderName);
        
        // Download all collected content at once if not cancelled
        if (!isCancelled && convertedPages.length > 0) {
          await downloadAllPagesAsZip(folderName);
        }
      } else {
        showStatus('Failed to extract page links: ' + (response?.error || 'Unknown error'), 'error');
      }
    } catch (error) {
      showStatus('An error occurred: ' + error.message, 'error');
    } finally {
      // Hide cancel button and re-enable batch button
      showCancelButton(false);
      disableBatchButton(false);
    }
  });

  // Cancel button click event
  cancelBtn.addEventListener('click', () => {
    isCancelled = true;
    showStatus('Cancelling batch operation...', 'info');
    showCancelButton(false);
    disableBatchButton(false);
  });

  // Send a message to the content script, re-injecting it once if the channel
  // is not yet available (e.g. first run before the script is loaded).
  async function sendMessageWithInjection(tabId, message) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      return await chrome.tabs.sendMessage(tabId, message);
    }
  }

  // Process all pages - collect conversion results but don't download immediately
  async function processAllPages(tabId, folderName) {
    let processedCount = 0;
    let errorCount = 0;

    // Remember the originally open page so we can return to it when done.
    const originalPage = allPages.find(page => page.selected);
    const originalUrl = originalPage?.url || "";
    const originalLabel = originalPage?.title || "";

    // Restore the page the user was on before the batch run.
    const restoreOriginal = async () => {
      try {
        if (isDevinMode) {
          if (originalLabel) {
            await sendMessageWithInjection(tabId, {
              action: 'clickDevinNavAndConvert',
              label: originalLabel,
              convert: false
            });
          }
        } else if (originalUrl) {
          await chrome.tabs.update(tabId, { url: originalUrl });
        }
      } catch (e) {
        // Restoring the original view is best-effort only.
        console.warn('Could not restore original page:', e);
      }
    };

    for (let i = 0; i < allPages.length; i++) {
      const page = allPages[i];

      if (isCancelled) {
        showStatus(`Operation cancelled. Processed: ${processedCount}, Failed: ${errorCount}`, 'info');
        await restoreOriginal();
        return;
      }

      try {
        showStatus(`Processing ${processedCount + 1}/${allPages.length}: ${page.title}`, 'info');

        let convertResponse;
        if (isDevinMode) {
          // Devin SPA: click the real sidebar button and convert in-place.
          // No reload and no URL guessing => far more reliable.
          convertResponse = await sendMessageWithInjection(tabId, {
            action: 'clickDevinNavAndConvert',
            label: page.title,
            index: typeof page.index === 'number' ? page.index : i
          });
        } else {
          // Traditional DeepWiki: navigate via real href and reload.
          await chrome.tabs.update(tabId, { url: page.url });
          await new Promise(resolve => setTimeout(resolve, 2000));

          if (isCancelled) {
            showStatus(`Operation cancelled. Processed: ${processedCount}, Failed: ${errorCount}`, 'info');
            await restoreOriginal();
            return;
          }

          convertResponse = await sendMessageWithInjection(tabId, { action: 'convertToMarkdown' });
        }

        if (convertResponse && convertResponse.success) {
          convertedPages.push({
            title: sanitizeFilename(convertResponse.markdownTitle || page.title),
            content: convertResponse.markdown
          });
          processedCount++;
        } else {
          errorCount++;
          console.error(`Page processing failed: ${page.title}`, convertResponse?.error);
        }
      } catch (err) {
        errorCount++;
        console.error(`Error processing page: ${page.title}`, err);
      }
    }

    await restoreOriginal();

    if (!isCancelled) {
      showStatus(`Batch conversion complete! Success: ${processedCount}, Failed: ${errorCount}, Preparing download...`, 'success');
    }
  }
  
  // Package all pages into a ZIP file for download
  async function downloadAllPagesAsZip(folderName) {
    try {
      showStatus('Creating ZIP file...', 'info');
      
      // Create new JSZip instance
      const zip = new JSZip();
      
      // Create index file
      let indexContent = `# ${folderName}\n\n## Content Index\n\n`;
      convertedPages.forEach(page => {
        indexContent += `- [${page.title}](${page.title}.md)\n`;
      });
      
      // Add index file to zip
      zip.file('README.md', indexContent);
      
      // Add all Markdown files to zip
      convertedPages.forEach(page => {
        const safeTitle = sanitizeFilename(page.title);
        zip.file(`${safeTitle}.md`, page.content);
      });
      
      // Generate zip file
      showStatus('Compressing files...', 'info');
      const zipContent = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 }
      });
      
      // Download zip file
      const zipUrl = URL.createObjectURL(zipContent);
      chrome.downloads.download({
        url: zipUrl,
        filename: `${sanitizeFilename(folderName)}.zip`,
        saveAs: true
      }, () => {
        if (chrome.runtime.lastError) {
          showStatus('Error downloading ZIP file: ' + chrome.runtime.lastError.message, 'error');
        } else {
          showStatus(`ZIP file successfully generated! Contains ${convertedPages.length} Markdown files`, 'success');
        }
      });
      
    } catch (error) {
      showStatus('Error creating ZIP file: ' + error.message, 'error');
    }
  }

  // Show or hide cancel button
  function showCancelButton(show) {
    cancelBtn.style.display = show ? 'block' : 'none';
  }

  // Enable or disable batch button
  function disableBatchButton(disable) {
    batchDownloadBtn.disabled = disable;
  }

  // Display status information
  function showStatus(message, type) {
    status.textContent = message;
    status.className = type;
  }
}); 