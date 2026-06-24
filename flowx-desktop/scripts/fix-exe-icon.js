const { rcedit } = require('rcedit');
const path = require('path');
const fs = require('fs');

const BUILD_DIR = path.join(__dirname, '..', 'build');
const RELEASE_DIR = path.join(__dirname, '..', 'release');
const ICON_PATH = path.join(BUILD_DIR, 'icon.ico');

async function fixExeIcon() {
  console.log('=== FlowX EXE 图标修复工具 ===\n');

  if (!fs.existsSync(ICON_PATH)) {
    console.error('❌ 图标文件不存在:', ICON_PATH);
    process.exit(1);
  }
  console.log('📷 图标文件:', ICON_PATH);

  // 查找 win-unpacked 目录下的 exe
  const unpackedDir = path.join(RELEASE_DIR, 'win-unpacked');
  if (!fs.existsSync(unpackedDir)) {
    console.error('❌ win-unpacked 目录不存在，请先运行 build');
    process.exit(1);
  }

  // 找到 FlowX.exe
  const exePath = path.join(unpackedDir, 'FlowX.exe');
  if (!fs.existsSync(exePath)) {
    console.error('❌ FlowX.exe 不存在:', exePath);
    // 尝试查找其他exe
    const files = fs.readdirSync(unpackedDir).filter(f => f.endsWith('.exe'));
    console.log('找到的exe文件:', files);
    process.exit(1);
  }
  console.log('📦 EXE 文件:', exePath);

  // 备份原exe（可选）
  // const backupPath = exePath + '.bak';
  // if (!fs.existsSync(backupPath)) {
  //   fs.copyFileSync(exePath, backupPath);
  //   console.log('💾 已备份原exe');
  // }

  console.log('\n🔨 正在设置exe图标...');
  console.log('   这可能需要几秒钟时间...');

  try {
    await rcedit(exePath, {
      'icon': ICON_PATH,
      'file-version': '0.1.0.0',
      'product-version': '0.1.0',
      'version-string': {
        'CompanyName': 'FlowX',
        'FileDescription': 'FlowX - 多平台内容发布工具',
        'LegalCopyright': 'Copyright © 2024 FlowX',
        'ProductName': 'FlowX',
        'OriginalFilename': 'FlowX.exe'
      }
    });
    console.log('✅ EXE 图标设置成功!');
  } catch (err) {
    console.error('❌ 设置图标失败:', err.message);
    process.exit(1);
  }

  // 验证文件是否存在
  if (fs.existsSync(exePath)) {
    const stats = fs.statSync(exePath);
    console.log(`\n📊 EXE 文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  }

  console.log('\n✅ 完成!');
}

fixExeIcon().catch(err => {
  console.error('❌ 脚本执行失败:', err);
  process.exit(1);
});
