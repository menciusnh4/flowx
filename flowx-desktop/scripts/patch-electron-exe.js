const { rcedit } = require('rcedit');
const path = require('path');
const fs = require('fs');

const BUILD_DIR = path.join(__dirname, '..', 'build');
const ELECTRON_DIST = path.join(__dirname, '..', 'node_modules', 'electron', 'dist');
const ICON_PATH = path.join(BUILD_DIR, 'icon.ico');

async function patchElectronExe() {
  console.log('=== Electron EXE 图标预修补工具 ===\n');

  if (!fs.existsSync(ICON_PATH)) {
    console.error('❌ 图标文件不存在:', ICON_PATH);
    process.exit(1);
  }
  console.log('📷 图标文件:', ICON_PATH);

  const electronExe = path.join(ELECTRON_DIST, 'electron.exe');
  if (!fs.existsSync(electronExe)) {
    console.error('❌ electron.exe 不存在:', electronExe);
    process.exit(1);
  }
  console.log('📦 Electron EXE:', electronExe);

  // 备份原electron.exe
  const backupExe = path.join(ELECTRON_DIST, 'electron.exe.default');
  if (!fs.existsSync(backupExe)) {
    fs.copyFileSync(electronExe, backupExe);
    console.log('💾 已备份默认electron.exe');
  } else {
    // 从备份恢复，确保从干净状态开始
    fs.copyFileSync(backupExe, electronExe);
    console.log('💾 已恢复默认electron.exe');
  }

  console.log('\n🔨 正在设置electron.exe图标和版本信息...');
  console.log('   这可能需要几秒钟时间...');

  try {
    await rcedit(electronExe, {
      'icon': ICON_PATH,
      'file-version': '0.1.0.0',
      'product-version': '0.1.0',
      'version-string': {
        'CompanyName': 'FlowX',
        'FileDescription': 'FlowX - 多平台内容发布工具',
        'LegalCopyright': 'Copyright © 2024 FlowX',
        'ProductName': 'FlowX',
        'OriginalFilename': 'FlowX.exe',
        'InternalName': 'FlowX'
      }
    });
    console.log('✅ electron.exe 图标设置成功!');
    
    const stats = fs.statSync(electronExe);
    console.log(`📊 electron.exe 大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  } catch (err) {
    console.error('❌ 设置图标失败:', err.message);
    console.error(err);
    process.exit(1);
  }

  console.log('\n✅ 完成! 现在可以运行 npm run build 打包了。');
}

patchElectronExe().catch(err => {
  console.error('❌ 脚本执行失败:', err);
  process.exit(1);
});
