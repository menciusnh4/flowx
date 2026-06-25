/**
 * electron-builder afterPack 钩子
 * 在打包完成后、生成安装包之前，用rcedit强制设置exe图标和版本信息
 * 解决electron-builder内置rcedit可能不生效的问题
 */
const { rcedit } = require('rcedit');
const path = require('path');
const fs = require('fs');

exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  
  // 只处理Windows平台
  if (electronPlatformName !== 'win32') {
    console.log('[afterPack] 非Windows平台，跳过图标修补');
    return;
  }

  const exeName = packager.appInfo.productFilename + '.exe';
  const exePath = path.join(appOutDir, exeName);
  const iconPath = path.join(packager.info.buildResourcesDir, 'icon.ico');

  console.log('\n========================================');
  console.log('[afterPack] 修补EXE图标和版本信息');
  console.log('[afterPack] EXE路径:', exePath);
  console.log('[afterPack] 图标路径:', iconPath);
  console.log('========================================\n');

  if (!fs.existsSync(exePath)) {
    console.error('[afterPack] ❌ EXE文件不存在:', exePath);
    return;
  }

  if (!fs.existsSync(iconPath)) {
    console.error('[afterPack] ❌ 图标文件不存在:', iconPath);
    return;
  }

  try {
    await rcedit(exePath, {
      'icon': iconPath,
      'file-version': packager.appInfo.version + '.0',
      'product-version': packager.appInfo.version,
      'version-string': {
        'CompanyName': 'FlowX',
        'FileDescription': 'FlowX - 多平台内容发布工具',
        'LegalCopyright': 'Copyright © 2024 FlowX',
        'ProductName': packager.appInfo.productName,
        'OriginalFilename': exeName,
        'InternalName': packager.appInfo.productName
      }
    });
    console.log('[afterPack] ✅ EXE图标和版本信息设置成功!');
  } catch (err) {
    console.error('[afterPack] ❌ 设置图标失败:', err.message);
    // 不抛出错误，避免构建失败
  }
};
