const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

async function generateIcons() {
  // 动态导入png-to-ico (ES Module)
  const pngToIco = (await import('png-to-ico')).default;
  
  const BUILD_DIR = path.join(__dirname, '..', 'build');
  const SOURCE = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'logo.png');

  console.log('=== FlowX 图标生成工具 ===\n');

  if (!fs.existsSync(SOURCE)) {
    console.error('❌ 源文件不存在:', SOURCE);
    process.exit(1);
  }

  const metadata = await sharp(SOURCE).metadata();
  console.log('📷 源图片:', metadata.width, 'x', metadata.height);

  // 使用完整图片（正方形）
  const size = Math.min(metadata.width || 1024, metadata.height || 1024);
  const left = Math.floor(((metadata.width || 1024) - size) / 2);
  const top = Math.floor(((metadata.height || 1024) - size) / 2);

  // ========== 按照electron-builder官方推荐 ==========
  // 1. 生成 1024x1024 icon.png (主源文件)
  console.log('\n🔨 生成 icon.png (1024x1024)...');
  await sharp(SOURCE)
    .extract({ left, top, width: size, height: size })
    .resize(1024, 1024, { fit: 'cover', kernel: sharp.kernel.lanczos3 })
    .png()
    .toFile(path.join(BUILD_DIR, 'icon.png'));
  console.log('  ✅ icon.png 已生成');

  // 2. 生成各尺寸PNG用于构建icon.ico
  console.log('\n🔨 生成各尺寸PNG用于icon.ico...');
  const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
  const tmpPngPaths = [];
  
  for (const s of ICO_SIZES) {
    const tmpPath = path.join(BUILD_DIR, `_tmp_ico_${s}.png`);
    await sharp(SOURCE)
      .extract({ left, top, width: size, height: size })
      .resize(s, s, { fit: 'cover', kernel: sharp.kernel.lanczos3 })
      .png()
      .toFile(tmpPath);
    tmpPngPaths.push(tmpPath);
    console.log(`  ✅ ${s}x${s}`);
  }

  // 3. 生成 icon.ico (Windows预构建图标，electron-builder会直接使用)
  console.log('\n🔨 生成 icon.ico...');
  try {
    const icoBuf = await pngToIco(tmpPngPaths);
    fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), icoBuf);
    console.log(`  ✅ icon.ico: ${(icoBuf.length / 1024).toFixed(1)} KB`);
  } catch (err) {
    console.warn('  ⚠️ png-to-ico失败，将依赖electron-builder自动转换:', err.message);
  }

  // 清理临时文件
  console.log('\n🧹 清理临时文件...');
  for (const p of tmpPngPaths) {
    try { fs.unlinkSync(p); } catch (e) {}
  }

  // 清理旧文件
  ['icon-256.png', 'icon-512.png', 'icon-1024.png'].forEach(f => {
    const p = path.join(BUILD_DIR, f);
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch(e){} }
  });

  console.log('\n✅ 所有图标生成完成!');
  console.log('\n📋 build/ 目录:');
  console.log('  icon-source.jpg - 源图片');
  console.log('  icon.png        - 1024x1024 PNG (主源)');
  console.log('  icon.ico        - Windows ICO (预构建，多尺寸)');
}

generateIcons().catch(err => {
  console.error('❌ 生成图标失败:', err);
  process.exit(1);
});
