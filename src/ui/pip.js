// Document Picture-in-Picture: float the ride panel in an always-on-top window
// (Chrome / Edge 116+). The panel element itself moves into the PiP window, so
// its event listeners and canvas keep working; it moves back when closed.

export function pipSupported() {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window;
}

export async function popOut(panel, { width = 400, height = 720, onClose } = {}) {
  if (!pipSupported()) throw new Error('Picture-in-picture windows need Chrome or Edge 116 or newer.');
  const pipWin = await window.documentPictureInPicture.requestWindow({ width, height });

  for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
    pipWin.document.head.appendChild(node.cloneNode(true));
  }
  pipWin.document.title = 'Pacer';
  pipWin.document.body.classList.add('pip-body');

  const parent = panel.parentNode;
  const next = panel.nextSibling;
  pipWin.document.body.append(panel);

  pipWin.addEventListener('pagehide', () => {
    parent.insertBefore(panel, next);
    onClose?.();
  });
  return pipWin;
}
