import { safeStorage, app } from 'electron';
import Store from 'electron-store';
import { logger } from '../utils/logger';
import type { AccountCredential, PublishTask, AccountCategory, BrowserEnvironment, ProxyConfig } from '../../types';

// 本地加密存储（主进程单例）
// - accounts: 账号列表（含凭证）
// - publishTasks: 发布历史
// - settings: 通用配置
//
// 敏感字段（cookies/access_token 等）使用 Electron safeStorage 加密。

interface StoreSchema {
  accounts: AccountCredential[];
  publishTasks: PublishTask[];
  settings: {
    theme?: 'light' | 'dark' | 'auto';
    autoPublishConcurrency?: number;
  };
  categories: AccountCategory[];
  environments: BrowserEnvironment[];
  proxies: ProxyConfig[];
}

let store: Store<StoreSchema> | null = null;
let encryptionAvailable = false;

export function initStore() {
  if (store) return;
  store = new Store<StoreSchema>({
    name: 'flowx-data',
    fileExtension: 'json',
    encryptionKey: 'flowx-local-key-obfuscation', // 轻混淆，敏感字段另用 safeStorage
    defaults: {
      accounts: [],
      publishTasks: [],
      settings: { theme: 'auto', autoPublishConcurrency: 3 },
      categories: [],
      environments: [],
      proxies: [],
    },
  });

  try {
    encryptionAvailable = safeStorage.isEncryptionAvailable();
    logger.info('[Store] 加密存储可用:', encryptionAvailable);
  } catch (err) {
    logger.warn('[Store] safeStorage 不可用，降级使用内存加密', err);
    encryptionAvailable = false;
  }
}

export function getStore(): Store<StoreSchema> {
  if (!store) throw new Error('Store not initialized');
  return store;
}

/** 加密敏感字符串（若可用） */
export function encrypt(plain: string): string {
  if (!plain) return '';
  try {
    if (encryptionAvailable) {
      const buf = safeStorage.encryptString(plain);
      return buf.toString('base64') + ':enc';
    }
  } catch (err) {
    logger.warn('[Store] 加密失败', err);
  }
  // Fallback: 简单 base64（仅避免明文）
  return Buffer.from(plain, 'utf8').toString('base64') + ':b64';
}

/** 解密 */
export function decrypt(cipher: string): string {
  if (!cipher) return '';
  try {
    if (cipher.endsWith(':enc')) {
      const raw = Buffer.from(cipher.slice(0, -4), 'base64');
      return safeStorage.decryptString(raw);
    }
    if (cipher.endsWith(':b64')) {
      return Buffer.from(cipher.slice(0, -4), 'base64').toString('utf8');
    }
    return cipher;
  } catch (err) {
    logger.warn('[Store] 解密失败', err);
    return '';
  }
}

/** 获取用户数据目录路径，供外部使用 */
export function getUserDataPath(): string {
  return app.getPath('userData');
}
