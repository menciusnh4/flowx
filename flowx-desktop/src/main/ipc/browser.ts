import { safeInvoke } from './index';
import {
  createBrowserView,
  destroyBrowserView,
  setViewBounds,
  navigate,
  goBack,
  goForward,
  reload,
  stop,
  switchEnvironment,
  setIgnoreCertErrors,
  isIgnoringCertErrors,
} from '../services/BrowserService';
import { extractContentFromView, extractContentFromElement, startElementSelector, stopElementSelector } from '../services/ContentExtractor';
import { downloadImages } from '../services/ImageDownloader';
import type { BrowserViewInfo } from '../services/BrowserService';
import type { ExtractedContent } from '../services/ContentExtractor';
import fs from 'fs';
import path from 'path';

export function registerBrowserIpc(): void {
  safeInvoke<BrowserViewInfo>(
    'browser:createView',
    (options?: { url?: string; envId?: string | null }) => {
      return createBrowserView(options);
    },
  );

  safeInvoke<boolean>(
    'browser:destroyView',
    (viewId: string) => {
      destroyBrowserView(viewId);
      return true;
    },
  );

  safeInvoke<boolean>(
    'browser:setBounds',
    (viewId: string, bounds: { x: number; y: number; width: number; height: number }) => {
      setViewBounds(viewId, bounds);
      return true;
    },
  );

  safeInvoke<boolean>(
    'browser:navigate',
    (viewId: string, url: string) => {
      navigate(viewId, url);
      return true;
    },
  );

  safeInvoke<boolean>(
    'browser:goBack',
    (viewId: string) => {
      goBack(viewId);
      return true;
    },
  );

  safeInvoke<boolean>(
    'browser:goForward',
    (viewId: string) => {
      goForward(viewId);
      return true;
    },
  );

  safeInvoke<boolean>(
    'browser:reload',
    (viewId: string) => {
      reload(viewId);
      return true;
    },
  );

  safeInvoke<boolean>(
    'browser:stop',
    (viewId: string) => {
      stop(viewId);
      return true;
    },
  );

  safeInvoke<boolean>(
    'browser:switchEnv',
    (viewId: string, envId: string | null) => {
      return switchEnvironment(viewId, envId).then(() => true);
    },
  );

  safeInvoke<boolean>(
    'browser:setIgnoreCertErrors',
    (viewId: string, ignore: boolean) => {
      setIgnoreCertErrors(viewId, ignore);
      return true;
    },
  );

  safeInvoke<boolean>(
    'browser:isIgnoringCertErrors',
    (viewId: string) => {
      return isIgnoringCertErrors(viewId);
    },
  );

  safeInvoke<ExtractedContent | null>(
    'browser:extractContent',
    (viewId: string) => {
      return extractContentFromView(viewId);
    },
  );

  safeInvoke<ExtractedContent | null>(
    'browser:manualExtract',
    (viewId: string, selector: string) => {
      return extractContentFromElement(viewId, selector);
    },
  );

  safeInvoke<boolean>(
    'browser:startSelector',
    (viewId: string) => {
      return startElementSelector(viewId).then(() => true);
    },
  );

  safeInvoke<boolean>(
    'browser:stopSelector',
    (viewId: string) => {
      return stopElementSelector(viewId).then(() => true);
    },
  );

  safeInvoke<string[]>(
    'browser:downloadImages',
    (imageUrls: string[], envId?: string | null) => {
      return downloadImages(imageUrls, { envId });
    },
  );

  safeInvoke<string>(
    'browser:getImageDataUrl',
    (filePath: string) => {
      return getImageDataUrl(filePath);
    },
  );
}

/**
 * 获取本地图片的 dataURL（base64），用于前端预览
 */
function getImageDataUrl(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) {
      return '';
    }
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
    };
    const mimeType = mimeMap[ext] || 'image/jpeg';
    const data = fs.readFileSync(filePath);
    return `data:${mimeType};base64,${data.toString('base64')}`;
  } catch (e) {
    console.error('[browser:getImageDataUrl] error:', e);
    return '';
  }
}
