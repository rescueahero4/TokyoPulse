import { createRoot } from 'react-dom/client';
import App from './App';

/**
 * NOT wrapped in <StrictMode>: React 18 StrictMode double-mounts effects, which
 * creates and immediately destroys a Cesium Viewer. The surviving viewer then
 * renders an empty globe (zero quadtree tiles). Verified in the browser.
 */

const host = document.getElementById('root');
if (!host) {
  document.body.innerHTML = '<pre style="color:#e6edf3;background:#0b0f14;padding:16px">#root missing</pre>';
} else {
  createRoot(host).render(<App />);
}
