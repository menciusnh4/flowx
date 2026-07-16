// 合规预检 IPC 通道（沿用 safeInvoke）
// 渲染端通过 compliance:scan 拿主进程扫描结果（单一真理源，零依赖重复）。
import { safeInvoke } from './index';
import { logger } from '../utils/logger';
import { ComplianceService } from '../services/compliance/ComplianceService';
import { dictionary } from '../services/compliance/dictionary';
import type { ComplianceScanRequest } from '../../types/compliance';

export function registerComplianceIpc(): void {
  // 预热词库（构建 trie 一次）；失败不阻断启动
  dictionary.warmup().catch((e) => logger.warn('[Compliance] 词库预热失败', e));

  safeInvoke('compliance:scan', (req: ComplianceScanRequest) =>
    ComplianceService.scanText(req.platform, req.fields),
  );
  safeInvoke('compliance:getSettings', () => ComplianceService.getSettings());
  safeInvoke('compliance:setSettings', (patch: { promptEnabled?: boolean }) =>
    ComplianceService.setSettings(patch),
  );
}
